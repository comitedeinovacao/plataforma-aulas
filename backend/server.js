const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const { randomUUID } = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// ─── Config ───────────────────────────────────────────────────────────────────
const TEACHER_PASSWORD = process.env.TEACHER_PASSWORD || 'senac2025';
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
[DATA_DIR, UPLOADS_DIR].forEach(d => !fs.existsSync(d) && fs.mkdirSync(d, { recursive: true }));

// ─── Lessons DB (JSON file) ───────────────────────────────────────────────────
const LESSONS_FILE = path.join(DATA_DIR, 'lessons.json');
function getLessons() {
  if (!fs.existsSync(LESSONS_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(LESSONS_FILE, 'utf8')); }
  catch { return []; }
}
function saveLessons(lessons) {
  fs.writeFileSync(LESSONS_FILE, JSON.stringify(lessons, null, 2));
}

// ─── Room Code Generator ──────────────────────────────────────────────────────
const ROOM_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function generateRoomCode() {
  let code = '';
  for (let i = 0; i < 6; i++) code += ROOM_CHARS[Math.floor(Math.random() * ROOM_CHARS.length)];
  return sessions.has(code) ? generateRoomCode() : code;
}

// ─── In-memory Sessions ───────────────────────────────────────────────────────
const sessions = new Map();   // roomCode → session
const socketMeta = new Map(); // socketId → { role, roomCode, name }

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(express.json());
app.use(session({
  secret: 'plataforma-aulas-senac-secret-2025',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 8 * 60 * 60 * 1000 }
}));
app.use(express.static(path.join(__dirname, '../frontend')));
app.use('/uploads', express.static(UPLOADS_DIR));

const auth = (req, res, next) =>
  req.session?.authenticated ? next() : res.status(401).json({ error: 'Não autenticado' });

// ─── File Upload ──────────────────────────────────────────────────────────────
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOADS_DIR,
    filename: (_, file, cb) => cb(null, `${randomUUID()}${path.extname(file.originalname)}`),
  }),
  fileFilter: (_, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, ['.pdf', '.html', '.htm'].includes(ext));
  },
  limits: { fileSize: 200 * 1024 * 1024 },
});

// ─── API Routes ───────────────────────────────────────────────────────────────
app.post('/api/login', (req, res) => {
  if (req.body.password === TEACHER_PASSWORD) {
    req.session.authenticated = true;
    res.json({ ok: true });
  } else {
    res.status(401).json({ error: 'Senha incorreta' });
  }
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/me', (req, res) => {
  res.json({ authenticated: !!req.session?.authenticated });
});

app.get('/api/lessons', auth, (req, res) => res.json(getLessons()));

app.post('/api/lessons/upload', auth, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Arquivo inválido ou não enviado' });
  const ext = path.extname(req.file.originalname).toLowerCase();
  const lesson = {
    id: randomUUID(),
    name: (req.body.name || '').trim() || path.basename(req.file.originalname, ext),
    type: ext === '.pdf' ? 'pdf' : 'html',
    filename: req.file.filename,
    originalName: req.file.originalname,
    uploadedAt: new Date().toISOString(),
    size: req.file.size,
  };
  const lessons = getLessons();
  lessons.unshift(lesson);
  saveLessons(lessons);
  res.json(lesson);
});

app.delete('/api/lessons/:id', auth, (req, res) => {
  const lessons = getLessons();
  const idx = lessons.findIndex(l => l.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Não encontrada' });
  const [lesson] = lessons.splice(idx, 1);
  const filePath = path.join(UPLOADS_DIR, lesson.filename);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  saveLessons(lessons);
  res.json({ ok: true });
});

app.post('/api/sessions', auth, (req, res) => {
  const lesson = getLessons().find(l => l.id === req.body.lessonId);
  if (!lesson) return res.status(404).json({ error: 'Aula não encontrada' });
  const roomCode = generateRoomCode();
  sessions.set(roomCode, {
    roomCode, lesson,
    currentSlide: 0,
    totalSlides: 1,
    students: new Map(),
    activeQuiz: null,
    quizResults: {},
    teacherSocket: null,
    createdAt: Date.now(),
  });
  res.json({ roomCode });
});

app.get('/api/sessions/:code', (req, res) => {
  const s = sessions.get(req.params.code.toUpperCase());
  if (!s) return res.status(404).json({ error: 'Sala não encontrada ou encerrada' });
  res.json({ roomCode: s.roomCode, lessonName: s.lesson.name, studentCount: s.students.size });
});

// ─── Socket.io ────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {

  socket.on('professor:join', ({ roomCode }) => {
    const s = sessions.get(roomCode);
    if (!s) return socket.emit('error', 'Sala não encontrada');
    s.teacherSocket = socket.id;
    socket.join(roomCode);
    socketMeta.set(socket.id, { role: 'professor', roomCode });
    socket.emit('session:state', {
      currentSlide: s.currentSlide,
      totalSlides: s.totalSlides,
      students: [...s.students.values()].map(({ id, name }) => ({ id, name })),
      lesson: s.lesson,
    });
  });

  socket.on('student:join', ({ roomCode, name }) => {
    const code = (roomCode || '').toUpperCase().trim();
    const s = sessions.get(code);
    if (!s) return socket.emit('join:error', 'Sala não encontrada. Verifique o código.');
    if (!name?.trim()) return socket.emit('join:error', 'Informe seu nome');
    const student = { id: socket.id, name: name.trim() };
    s.students.set(socket.id, student);
    socket.join(code);
    socketMeta.set(socket.id, { role: 'student', roomCode: code, name: student.name });
    socket.emit('join:success', {
      currentSlide: s.currentSlide,
      totalSlides: s.totalSlides,
      lesson: { type: s.lesson.type, filename: s.lesson.filename, name: s.lesson.name },
      activeQuiz: s.activeQuiz,
    });
    if (s.teacherSocket) {
      io.to(s.teacherSocket).emit('student:joined', { id: socket.id, name: student.name, count: s.students.size });
    }
  });

  socket.on('slide:change', ({ slide, total }) => {
    const meta = socketMeta.get(socket.id);
    if (!meta || meta.role !== 'professor') return;
    const s = sessions.get(meta.roomCode);
    if (!s) return;
    s.currentSlide = slide;
    if (total) s.totalSlides = total;
    socket.to(meta.roomCode).emit('slide:changed', { slide, total: s.totalSlides });
  });

  socket.on('quiz:launch', (quiz) => {
    const meta = socketMeta.get(socket.id);
    if (!meta || meta.role !== 'professor') return;
    const s = sessions.get(meta.roomCode);
    if (!s) return;
    s.activeQuiz = quiz;
    s.quizResults = {};
    io.to(meta.roomCode).emit('quiz:launched', quiz);
  });

  socket.on('quiz:answer', ({ answer }) => {
    const meta = socketMeta.get(socket.id);
    if (!meta || meta.role !== 'student') return;
    const s = sessions.get(meta.roomCode);
    if (!s?.activeQuiz) return;
    if (s.quizResults[meta.name]) return; // already answered
    const correct = answer === s.activeQuiz.correctAnswer;
    s.quizResults[meta.name] = { answer, correct };
    socket.emit('quiz:answered', { correct });
    const results = Object.values(s.quizResults);
    const breakdown = {};
    s.activeQuiz.options.forEach(o => { breakdown[o] = 0; });
    results.forEach(r => { if (breakdown[r.answer] !== undefined) breakdown[r.answer]++; });
    if (s.teacherSocket) {
      io.to(s.teacherSocket).emit('quiz:results', {
        results: s.quizResults, breakdown,
        totalStudents: s.students.size,
        answered: results.length,
        correct: results.filter(r => r.correct).length,
      });
    }
  });

  socket.on('quiz:end', () => {
    const meta = socketMeta.get(socket.id);
    if (!meta || meta.role !== 'professor') return;
    const s = sessions.get(meta.roomCode);
    if (!s) return;
    const results = Object.values(s.quizResults);
    const breakdown = {};
    if (s.activeQuiz) {
      s.activeQuiz.options.forEach(o => { breakdown[o] = 0; });
      results.forEach(r => { if (breakdown[r.answer] !== undefined) breakdown[r.answer]++; });
    }
    io.to(meta.roomCode).emit('quiz:ended', {
      breakdown, correctAnswer: s.activeQuiz?.correctAnswer,
      correct: results.filter(r => r.correct).length,
      answered: results.length, totalStudents: s.students.size,
    });
    s.activeQuiz = null;
    s.quizResults = {};
  });

  socket.on('draw:data', (data) => {
    const meta = socketMeta.get(socket.id);
    if (!meta || meta.role !== 'professor') return;
    socket.to(meta.roomCode).emit('draw:data', data);
  });

  socket.on('draw:clear', () => {
    const meta = socketMeta.get(socket.id);
    if (!meta || meta.role !== 'professor') return;
    socket.to(meta.roomCode).emit('draw:clear');
  });

  socket.on('disconnect', () => {
    const meta = socketMeta.get(socket.id);
    if (!meta) return;
    const s = sessions.get(meta.roomCode);
    if (s) {
      if (meta.role === 'professor') {
        io.to(meta.roomCode).emit('session:ended');
        sessions.delete(meta.roomCode);
      } else {
        s.students.delete(socket.id);
        if (s.teacherSocket) {
          io.to(s.teacherSocket).emit('student:left', { id: socket.id, name: meta.name, count: s.students.size });
        }
      }
    }
    socketMeta.delete(socket.id);
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`\n  🎓  Plataforma de Aulas — Senac Araçatuba`);
  console.log(`  🌐  http://localhost:${PORT}`);
  console.log(`  🔑  Senha do professor: ${TEACHER_PASSWORD}\n`);
});
