const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const API_CATALOG_URL = "https://api-mobile.planetakino.ua/graphql/movieCatalogQuery";
const API_SESSION_URL = "https://api-mobile.planetakino.ua/graphql/sessionById";
const CINEMA_ID = "Z2lkOi8vY2luZW1hLzEz"; 

const headers = {
    "accept": "application/json",
    "content-type": "application/json",
    "pk-app-type": "web",
    "pk-app-version": "1.29.0",
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/150.0.0.0 Safari/537.36"
};

// ==========================================
// ГІБРИДНА ПАМ'ЯТЬ ДЛЯ НАЛАШТУВАНЬ ФІЛЬМІВ
// ==========================================
let serverSettings = {
    durations: {
        "ОДІССЕЯ": 120,
        "АКАДЕМІЯ ЧАРІВНИКІВ": 105,
        "ІСТОРІЯ ІГРАШОК 5": 100,
        "ПОСІПАКИ І МОНСТРЯКИ": 95,
        "ТЕСТ НА ТЕЩУ 2": 110,
        "БРУДНІ ГРОШІ": 130
    },
    exceptions: {
        "ОДІССЕЯ": { "12:30": 90, "18:00": 100 },
        "БРУДНІ ГРОШІ": { "21:15": 120 }
    }
};
let settingsModifiedAt = Date.now(); // Час останньої зміни

const scheduleQuery = `
query movieCatalogQuery($cinemaId: String!, $offlineStartAtOrAfter: String, $offlineStartAtOrBefore: String) {
  fullMovies: moviesV2(cinemaId: $cinemaId, offlineStartAtOrAfter: $offlineStartAtOrAfter, offlineStartAtOrBefore: $offlineStartAtOrBefore, first: 100) {
    nodes { name, offlineRental(cinemaId: $cinemaId) { sessions { id, startSessionAt } } }
  }
}`;

const seatsQuery = `
query sessionById($id: ID!) {
  sessionById(id: $id) { cinemaHall { name, rows { seats { state } } } }
}`;

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function fetchGraphQL(url, query, variables) {
    const response = await fetch(url, { method: "POST", headers, body: JSON.stringify({ query, variables }) });
    if (!response.ok) throw new Error(`HTTP Error: ${response.status}`);
    return response.json();
}

const serverSessionCache = {};

async function getTicketsReport(targetDate, clientCachedSessions) {
    const startTime = `${targetDate}T00:00:00.000Z`;
    const endTime = `${targetDate}T23:59:59.000Z`;

    const scheduleResult = await fetchGraphQL(API_CATALOG_URL, scheduleQuery, {
        cinemaId: CINEMA_ID, offlineStartAtOrAfter: startTime, offlineStartAtOrBefore: endTime
    });

    if (!serverSessionCache[targetDate]) serverSessionCache[targetDate] = new Map();
    const sessionMap = serverSessionCache[targetDate];

    for (let session of sessionMap.values()) session.isFresh = false;

    if (clientCachedSessions && Array.isArray(clientCachedSessions)) {
        clientCachedSessions.forEach(cs => {
            if (!sessionMap.has(cs.id)) sessionMap.set(cs.id, { id: cs.id, movieName: cs.movieName, time: cs.time, hall: cs.hall, isFresh: false });
        });
    }

    if (scheduleResult.data?.fullMovies?.nodes) {
        scheduleResult.data.fullMovies.nodes.forEach(movie => {
            if (movie.offlineRental?.sessions) {
                movie.offlineRental.sessions.forEach(session => {
                    const time = new Date(session.startSessionAt).toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Kyiv' });
                    if (sessionMap.has(session.id)) {
                        const existingSession = sessionMap.get(session.id);
                        existingSession.isFresh = true;
                        existingSession.time = time;
                        existingSession.movieName = movie.name;
                    } else {
                        sessionMap.set(session.id, { id: session.id, movieName: movie.name, time: time, isFresh: true });
                    }
                });
            }
        });
    }

    const kyivNow = new Date(new Date().toLocaleString("en-US", {timeZone: "Europe/Kyiv"}));
    const [year, month, day] = targetDate.split('-').map(Number);

    for (let [id, session] of sessionMap.entries()) {
        if (!session.isFresh) {
            const [h, m] = session.time.split(':').map(Number);
            const sessionDate = new Date(year, month - 1, day, h, m, 0);
            if (sessionDate > kyivNow) sessionMap.delete(id);
        }
    }

    let allSessions = Array.from(sessionMap.values());
    allSessions.sort((a, b) => a.time.localeCompare(b.time));

    let totalSold = 0;
    const chronological = [];
    const groupedByHall = {};

    const chunkSize = 10;
    for (let i = 0; i < allSessions.length; i += chunkSize) {
        const chunk = allSessions.slice(i, i + chunkSize);
        const promises = chunk.map(async (session) => {
            try {
                const seatsResult = await fetchGraphQL(API_SESSION_URL, seatsQuery, { id: session.id });
                return { session, seatsResult };
            } catch (error) { return { session, seatsResult: null }; }
        });

        const results = await Promise.all(promises);

        for (const { session, seatsResult } of results) {
            if (!seatsResult) continue;
            const hallName = seatsResult.data?.sessionById?.cinemaHall?.name || session.hall || "Невідомо";
            sessionMap.set(session.id, { ...sessionMap.get(session.id), hall: hallName });

            const rows = seatsResult.data?.sessionById?.cinemaHall?.rows || [];
            let soldForSession = 0;
            rows.forEach(row => { row.seats.forEach(seat => { if (seat.state === 'SOLD') soldForSession++; }); });

            const sessionData = { id: session.id, time: session.time, movieName: session.movieName, sold: soldForSession, hall: hallName, isFresh: session.isFresh };
            chronological.push(sessionData);
            if (!groupedByHall[hallName]) groupedByHall[hallName] = [];
            groupedByHall[hallName].push(sessionData);
            totalSold += soldForSession;
        }
        if (i + chunkSize < allSessions.length) await delay(300);
    }

    return { date: targetDate, total: totalSold, chronological, grouped: groupedByHall };
}

// ГОЛОВНИЙ РОУТ ДЛЯ ОТРИМАННЯ ДАНИХ
app.post('/api/tickets', async (req, res) => {
    try {
        const { date, cachedSessions, clientSettings, clientSettingsTime } = req.body;
        if (!date) return res.status(400).json({ error: "Вкажіть дату" });
        
        // Синхронізація налаштувань: якщо телефон адміна має новіші налаштування, ніж сервер
        if (clientSettings && clientSettingsTime && clientSettingsTime > settingsModifiedAt) {
            serverSettings = clientSettings;
            settingsModifiedAt = clientSettingsTime;
            console.log("Сервер оновив налаштування з пристрою адміна!");
        }

        const data = await getTicketsReport(date, cachedSessions);
        
        // Додаємо актуальні налаштування у відповідь
        data.settings = serverSettings;
        data.settingsTime = settingsModifiedAt;

        res.json(data);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Помилка при зборі даних" });
    }
});

// РОУТ ДЛЯ ЗБЕРЕЖЕННЯ НАЛАШТУВАНЬ З АДМІНКИ
app.post('/api/settings', (req, res) => {
    const { secret, newSettings } = req.body;
    
    // Секретний пароль (ти можеш змінити його тут)
    if (secret !== "reluxadmin") {
        return res.status(403).json({ error: "Невірний пароль адміністратора" });
    }

    serverSettings = newSettings;
    settingsModifiedAt = Date.now();
    res.json({ success: true, settings: serverSettings, settingsTime: settingsModifiedAt });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Сервер працює: http://localhost:${PORT}`));
