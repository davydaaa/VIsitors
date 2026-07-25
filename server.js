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
    const response = await fetch(url, {
        method: "POST", headers, body: JSON.stringify({ query, variables })
    });
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

    if (!serverSessionCache[targetDate]) {
        serverSessionCache[targetDate] = new Map();
    }
    const sessionMap = serverSessionCache[targetDate];

    // Очищаємо статус "свіжості"
    for (let session of sessionMap.values()) {
        session.isFresh = false;
    }

    if (clientCachedSessions && Array.isArray(clientCachedSessions)) {
        clientCachedSessions.forEach(cs => {
            if (!sessionMap.has(cs.id)) {
                sessionMap.set(cs.id, { id: cs.id, movieName: cs.movieName, time: cs.time, hall: cs.hall, isFresh: false });
            }
        });
    }

    if (scheduleResult.data?.fullMovies?.nodes) {
        scheduleResult.data.fullMovies.nodes.forEach(movie => {
            if (movie.offlineRental?.sessions) {
                movie.offlineRental.sessions.forEach(session => {
                    const time = new Date(session.startSessionAt).toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Kyiv' });
                    if (sessionMap.has(session.id)) {
                        sessionMap.get(session.id).isFresh = true; 
                    } else {
                        sessionMap.set(session.id, { id: session.id, movieName: movie.name, time: time, isFresh: true });
                    }
                });
            }
        });
    }

    let allSessions = Array.from(sessionMap.values());
    allSessions.sort((a, b) => a.time.localeCompare(b.time));

    let totalSold = 0;
    let totalBooked = 0;
    const chronological = [];
    const groupedByHall = {};

    // 🔥 СТАВИМО 25, щоб при 20-24 сеансах все вантажилось за 1 раз без пауз
    const CHUNK_SIZE = 25; 
    
    for (let i = 0; i < allSessions.length; i += CHUNK_SIZE) {
        const chunk = allSessions.slice(i, i + CHUNK_SIZE);
        
        // Запускаємо всі запити партії паралельно
        await Promise.all(chunk.map(async (session) => {
            try {
                const seatsResult = await fetchGraphQL(API_SESSION_URL, seatsQuery, { id: session.id });
                const hallName = seatsResult.data?.sessionById?.cinemaHall?.name || session.hall || "Невідомо";
                
                sessionMap.set(session.id, { ...sessionMap.get(session.id), hall: hallName });

                const rows = seatsResult.data?.sessionById?.cinemaHall?.rows || [];
                
                let soldForSession = 0;
                let bookedForSession = 0;
                
                rows.forEach(row => {
                    row.seats.forEach(seat => { 
                        if (seat.state === 'SOLD') soldForSession++; 
                        else if (seat.state === 'BOOKED') bookedForSession++;
                    });
                });

                const sessionData = { 
                    id: session.id, time: session.time, movieName: session.movieName, 
                    sold: soldForSession, booked: bookedForSession, hall: hallName, isFresh: session.isFresh 
                };
                
                chronological.push(sessionData);
                
                if (!groupedByHall[hallName]) groupedByHall[hallName] = [];
                groupedByHall[hallName].push(sessionData);
                
                totalSold += soldForSession;
                totalBooked += bookedForSession;
            } catch (err) {
                console.error(`Помилка завантаження місць для сеансу ${session.id}:`, err);
            }
        }));

        // Пауза спрацює ТІЛЬКИ якщо сеансів буде більше ніж 25
        if (i + CHUNK_SIZE < allSessions.length) {
            await delay(300);
        }
    }

    chronological.sort((a, b) => a.time.localeCompare(b.time));
    for (const hallName in groupedByHall) {
        groupedByHall[hallName].sort((a, b) => a.time.localeCompare(b.time));
    }

    return { date: targetDate, total: totalSold, totalBooked: totalBooked, chronological, grouped: groupedByHall };
}

app.post('/api/tickets', async (req, res) => {
    try {
        const { date, cachedSessions } = req.body;
        if (!date) return res.status(400).json({ error: "Вкажіть дату" });
        
        const data = await getTicketsReport(date, cachedSessions);
        res.json(data);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Помилка при зборі даних" });
    }
});

app.get('/api/tickets', async (req, res) => {
    try {
        const date = req.query.date;
        if (!date) return res.status(400).json({ error: "Вкажіть дату" });
        
        const data = await getTicketsReport(date, []);
        res.json(data);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Помилка при зборі даних" });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Сервер працює: http://localhost:${PORT}`));
