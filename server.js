const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const API_CATALOG_URL = "https://api-mobile.planetakino.ua/graphql/movieCatalogQuery";
const API_SESSION_URL = "https://api-mobile.planetakino.ua/graphql/sessionById";

const headers = {
    "accept": "application/json",
    "content-type": "application/json",
    "pk-app-type": "web",
    "pk-app-version": "1.29.0",
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/150.0.0.0 Safari/537.36"
};

const scheduleQuery = `
query movieCatalogQuery(\$cinemaId: String!, $offlineStartAtOrAfter: String,$offlineStartAtOrBefore: String) {
  fullMovies: moviesV2(cinemaId: \$cinemaId, offlineStartAtOrAfter: $offlineStartAtOrAfter, offlineStartAtOrBefore:$offlineStartAtOrBefore, first: 100) {
    nodes { name, offlineRental(cinemaId: \$cinemaId) { sessions { id, startSessionAt } } }
  }
}`;

const seatsQuery = `
query sessionById(\$id: ID!) {
  sessionById(id: \$id) { cinemaHall { name, rows { seats { state } } } }
}`;

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Ізольована пам'ять під кожен кінотеатр
const serverSessionCache = {};

async function fetchGraphQL(url, query, variables) {
    const response = await fetch(url, {
        method: "POST", headers, body: JSON.stringify({ query, variables })
    });
    if (!response.ok) throw new Error(`HTTP Error: \${response.status}`);
    return response.json();
}

async function getTicketsReport(targetDate, clientCachedSessions, cinemaId) {
    const startTime = `\${targetDate}T00:00:00.000Z`;
    const endTime = `\${targetDate}T23:59:59.000Z`;

    const scheduleResult = await fetchGraphQL(API_CATALOG_URL, scheduleQuery, {
        cinemaId: cinemaId, offlineStartAtOrAfter: startTime, offlineStartAtOrBefore: endTime
    });

    if (!serverSessionCache[cinemaId]) serverSessionCache[cinemaId] = {};
    if (!serverSessionCache[cinemaId][targetDate]) serverSessionCache[cinemaId][targetDate] = new Map();
    
    const sessionMap = serverSessionCache[cinemaId][targetDate];

    for (let session of sessionMap.values()) {
        session.isFresh = false;
    }

    if (clientCachedSessions && Array.isArray(clientCachedSessions)) {
        clientCachedSessions.forEach(cs => {
            if (cs && cs.id && !sessionMap.has(cs.id)) {
                sessionMap.set(cs.id, { 
                    id: cs.id, 
                    movieName: cs.movieName || "Невідомо", 
                    time: cs.time || "00:00", 
                    hall: cs.hall || "Невідомо", 
                    isFresh: false 
                });
            }
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
            // ЗАХИСТ: якщо часу немає, ставимо 00:00
            const [h, m] = (session.time || "00:00").split(':').map(Number);
            const sessionDate = new Date(year, month - 1, day, h || 0, m || 0, 0);

            if (sessionDate > kyivNow) {
                sessionMap.delete(id);
            }
        }
    }

    let allSessions = Array.from(sessionMap.values());
    // ЗАХИСТ: безпечне сортування
    allSessions.sort((a, b) => (a.time || "").localeCompare(b.time || ""));

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
            } catch (error) {
                return { session, seatsResult: null }; 
            }
        });

        const results = await Promise.all(promises);

        for (const { session, seatsResult } of results) {
            if (!seatsResult) continue;

            const hallName = seatsResult.data?.sessionById?.cinemaHall?.name || session.hall || "Невідомо";
            sessionMap.set(session.id, { ...sessionMap.get(session.id), hall: hallName });

            const rows = seatsResult.data?.sessionById?.cinemaHall?.rows || [];
            
            let soldForSession = 0;
            let bookedForSession = 0; 
            
            rows.forEach(row => {
                row.seats.forEach(seat => { 
                    if (seat.state === 'SOLD') {
                        soldForSession++;
                    } else if (seat.state === 'BOOKED' || seat.state === 'RESERVED') {
                        bookedForSession++;
                    }
                });
            });

            const sessionData = { 
                id: session.id, 
                time: session.time, 
                movieName: session.movieName, 
                sold: soldForSession, 
                booked: bookedForSession, 
                hall: hallName, 
                isFresh: session.isFresh 
            };
            
            chronological.push(sessionData);
            
            if (!groupedByHall[hallName]) groupedByHall[hallName] = [];
            groupedByHall[hallName].push(sessionData);
            
            totalSold += soldForSession;
        }

        if (i + chunkSize < allSessions.length) {
            await delay(300);
        }
    }

    return { date: targetDate, total: totalSold, chronological, grouped: groupedByHall };
}

// === НОВІ МАРШРУТИ ===
app.get(['/', '/forum', '/forum/', '/kk', '/kk/'], (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.post('/api/tickets', async (req, res) => {
    try {
        const { date, cachedSessions, cinemaId } = req.body;
        if (!date) return res.status(400).json({ error: "Вкажіть дату" });
        
        const currentCinemaId = cinemaId || "Z2lkOi8vY2luZW1hLzEz";
        const data = await getTicketsReport(date, cachedSessions, currentCinemaId);
        res.json(data);
    } catch (error) {
        console.error("Критична помилка сервера:", error.message);
        res.status(500).json({ error: "Помилка при зборі даних на сервері" });
    }
});

app.get('/api/tickets', async (req, res) => {
    try {
        const date = req.query.date;
        const cinemaId = req.query.cinemaId || "Z2lkOi8vY2luZW1hLzEz";
        if (!date) return res.status(400).json({ error: "Вкажіть дату" });
        
        const data = await getTicketsReport(date, [], cinemaId);
        res.json(data);
    } catch (error) {
        console.error("Критична помилка сервера:", error.message);
        res.status(500).json({ error: "Помилка при зборі даних на сервері" });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Сервер працює: http://localhost:\${PORT}`));
