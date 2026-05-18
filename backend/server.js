const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const { randomUUID } = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.set('trust proxy', 1);

// ─── Config ───────────────────────────────────────────────────────────────────
const TEACHER_PASSWORD = process.env.TEACHER_PASSWORD || 'senac2025';
const PORT = process.env.PORT || 3000;
const isProd = process.env.NODE_ENV === 'production';
const DATA_DIR = path.join(__dirname, 'data');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
[DATA_DIR, UPLOADS_DIR].forEach(d => !fs.existsSync(d) && fs.mkdirSync(d, { recursive: true }));

// ─── Supabase (persistência em produção) ──────────────────────────────────────
let supabase = null;
if (process.env.SUPABASE_URL && process.env.SUPABASE_KEY) {
  supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
  console.log('  ☁️   Supabase conectado — armazenamento persistente ativo');
} else {
  console.log('  📁  Armazenamento local (configure SUPABASE_URL e SUPABASE_KEY para persistência)');
}
const BUCKET = 'aulas';

// ─── Lessons — armazenamento local (fallback) ─────────────────────────────────
const LESSONS_FILE = path.join(DATA_DIR, 'lessons.json');
function getLocalLessons() {
  if (!fs.existsSync(LESSONS_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(LESSONS_FILE, 'utf8')); }
  catch { return []; }
}
function saveLocalLessons(lessons) {
  fs.writeFileSync(LESSONS_FILE, JSON.stringify(lessons, null, 2));
}

// ─── Lessons — abstração (Supabase ou local) ──────────────────────────────────
async function getLessons() {
  if (supabase) {
    const { data, error } = await supabase
      .from('lessons')
      .select('*')
      .order('uploaded_at', { ascending: false });
    if (error) { console.error('Supabase getLessons:', error.message); return []; }
    return data;
  }
  return getLocalLessons();
}

async function deleteLesson(id) {
  if (supabase) {
    const { data: lesson } = await supabase.from('lessons').select('filename').eq('id', id).single();
    if (lesson?.filename) {
      await supabase.storage.from(BUCKET).remove([lesson.filename]);
    }
    await supabase.from('lessons').delete().eq('id', id);
  } else {
    const lessons = getLocalLessons();
    const idx = lessons.findIndex(l => l.id === id);
    if (idx === -1) return false;
    const [l] = lessons.splice(idx, 1);
    const fp = path.join(UPLOADS_DIR, l.filename);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
    saveLocalLessons(lessons);
  }
  return true;
}

// ─── Room Code Generator ──────────────────────────────────────────────────────
const ROOM_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function generateRoomCode() {
  let code = '';
  for (let i = 0; i < 6; i++) code += ROOM_CHARS[Math.floor(Math.random() * ROOM_CHARS.length)];
  return sessions.has(code) ? generateRoomCode() : code;
}

// ─── In-memory Sessions ───────────────────────────────────────────────────────
const sessions = new Map();
const socketMeta = new Map();

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(express.json());
app.use(session({
  secret: 'plataforma-aulas-senac-secret-2025',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 8 * 60 * 60 * 1000,
    secure: isProd,
    sameSite: isProd ? 'none' : 'lax',
  },
}));
app.use(express.static(path.join(__dirname, '../frontend')));
app.use('/uploads', express.static(UPLOADS_DIR));

const auth = (req, res, next) =>
  req.session?.authenticated ? next() : res.status(401).json({ error: 'Não autenticado' });

// ─── File Upload (sempre memória → decide destino depois) ─────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter: (_, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, ['.pdf', '.html', '.htm'].includes(ext));
  },
  limits: { fileSize: 50 * 1024 * 1024 },
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

app.get('/api/lessons', auth, async (req, res) => {
  res.json(await getLessons());
});

app.post('/api/lessons/upload', auth, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Arquivo inválido ou não enviado' });

  const ext = path.extname(req.file.originalname).toLowerCase();
  const uniqueName = `${randomUUID()}${ext}`;
  let url;

  try {
    if (supabase) {
      // Upload para Supabase Storage
      const { error: upErr } = await supabase.storage
        .from(BUCKET)
        .upload(uniqueName, req.file.buffer, { contentType: req.file.mimetype, upsert: false });
      if (upErr) throw upErr;

      const { data: urlData } = supabase.storage.from(BUCKET).getPublicUrl(uniqueName);
      url = urlData.publicUrl;
    } else {
      // Salva localmente
      fs.writeFileSync(path.join(UPLOADS_DIR, uniqueName), req.file.buffer);
      url = `/uploads/${uniqueName}`;
    }

    const lesson = {
      id: randomUUID(),
      name: (req.body.name || '').trim() || path.basename(req.file.originalname, ext),
      type: ext === '.pdf' ? 'pdf' : 'html',
      filename: uniqueName,
      url,
      original_name: req.file.originalname,
      uploaded_at: new Date().toISOString(),
      size: req.file.size,
    };

    if (supabase) {
      const { data, error } = await supabase.from('lessons').insert(lesson).select().single();
      if (error) throw error;
      res.json(data);
    } else {
      const lessons = getLocalLessons();
      lessons.unshift(lesson);
      saveLocalLessons(lessons);
      res.json(lesson);
    }
  } catch (err) {
    console.error('Erro no upload:', err.message);
    res.status(500).json({ error: 'Erro ao salvar arquivo: ' + err.message });
  }
});

app.delete('/api/lessons/:id', auth, async (req, res) => {
  try {
    const ok = await deleteLesson(req.params.id);
    if (!ok) return res.status(404).json({ error: 'Não encontrada' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/sessions', auth, async (req, res) => {
  const lessons = await getLessons();
  const lesson = lessons.find(l => l.id === req.body.lessonId);
  if (!lesson) return res.status(404).json({ error: 'Aula não encontrada' });

  const roomCode = generateRoomCode();
  sessions.set(roomCode, {
    roomCode, lesson,
    currentSlide: 0,
    totalSlides: 1,
    students: new Map(),
    activeQuiz: null,
    quizResults: {},
    activePoll: null,
    pollResponses: [],
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
      lesson: { type: s.lesson.type, filename: s.lesson.filename, url: s.lesson.url, name: s.lesson.name },
      activeQuiz: s.activeQuiz,
      activePoll: s.activePoll,
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
    if (s.quizResults[meta.name]) return;

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

  // ── Enquetes avançadas (nuvem, mural, ranking) ──────────────────────────────
  socket.on('poll:launch', (poll) => {
    const meta = socketMeta.get(socket.id);
    if (!meta || meta.role !== 'professor') return;
    const s = sessions.get(meta.roomCode);
    if (!s) return;
    s.activePoll = poll;
    s.pollResponses = [];
    io.to(meta.roomCode).emit('poll:launched', poll);
  });

  socket.on('poll:respond', ({ response }) => {
    const meta = socketMeta.get(socket.id);
    if (!meta || meta.role !== 'student') return;
    const s = sessions.get(meta.roomCode);
    if (!s?.activePoll) return;
    if (s.pollResponses.find(r => r.name === meta.name)) return;
    s.pollResponses.push({ name: meta.name, response });
    socket.emit('poll:responded');
    if (s.teacherSocket) {
      io.to(s.teacherSocket).emit('poll:results', {
        responses: s.pollResponses,
        poll: s.activePoll,
        totalStudents: s.students.size,
      });
    }
  });

  socket.on('poll:end', () => {
    const meta = socketMeta.get(socket.id);
    if (!meta || meta.role !== 'professor') return;
    const s = sessions.get(meta.roomCode);
    if (!s) return;
    io.to(meta.roomCode).emit('poll:ended');
    s.activePoll = null;
    s.pollResponses = [];
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

// Script injetado nas apresentações HTML para sincronização de slides
const SLIDE_SYNC_SCRIPT = `<script>
(function(){
  var slides=[],cur=0;
  function init(){
    slides=Array.from(document.querySelectorAll('.slide'));
    if(!slides.length)return;
    cur=Math.max(0,slides.findIndex(function(s){return s.classList.contains('active');}));
    report();
    new MutationObserver(function(ms){
      var hit=ms.some(function(m){return slides.indexOf(m.target)>=0;});
      if(!hit)return;
      var n=slides.findIndex(function(s){return s.classList.contains('active');});
      if(n>=0&&n!==cur){cur=n;report();}
    }).observe(document.body,{attributes:true,subtree:true,attributeFilter:['class']});
    window.addEventListener('message',function(e){
      if(e.data&&e.data.type==='goto')goTo(+e.data.slide);
    });
  }
  function goTo(n){
    if(n<0||n>=slides.length)return;
    slides.forEach(function(s,i){s.classList.toggle('active',i===n);});
  }
  function report(){
    try{window.parent.postMessage({type:'slideChange',slide:cur,total:slides.length},'*');}catch(e){}
  }
  document.readyState==='loading'?document.addEventListener('DOMContentLoaded',init):setTimeout(init,200);
})();
</script>`;

// Script injetado nas atividades HTML para tornar campos editáveis e enviar respostas
const ACTIVITY_SCRIPT = `<script>
(function(){
  var fields=document.querySelectorAll('.field-line,.field-line-lg');
  if(!fields.length) return; // não é atividade — saída silenciosa
  var sp=new URLSearchParams(location.search);
  var studentName=decodeURIComponent(sp.get('name')||'Aluno');
  var roomCode=decodeURIComponent(sp.get('room')||'');
  var lessonName=decodeURIComponent(sp.get('lessonName')||'Atividade');
  var lessonUrl=sp.get('url')||'';

  /* ── Notifica o pai que este frame é uma atividade (libera pointer events) ── */
  try{window.parent.postMessage({type:'activityReady'},'*');}catch(e){}

  /* ── Campos de texto editáveis ── */
  fields.forEach(function(el){
    el.contentEditable='true';
    el.style.outline='none';
    el.style.cursor='text';
    el.style.background='rgba(0,69,135,.07)';
    el.style.borderRadius='3px';
    el.style.padding='2px 6px';
    el.style.minHeight='1.5em';
    el.style.color='#001833';
    el.style.transition='background .15s';
    el.addEventListener('focus',function(){el.style.background='rgba(0,69,135,.13)';});
    el.addEventListener('blur',function(){el.style.background='rgba(0,69,135,.07)';});
  });

  /* ── Checkboxes clicáveis ── */
  document.querySelectorAll('.check-box,.chrono-check').forEach(function(el){
    el.style.cursor='pointer';
    el.dataset.checked='0';
    el.addEventListener('click',function(e){
      e.stopPropagation();
      var on=el.dataset.checked!=='1';
      el.dataset.checked=on?'1':'0';
      el.style.background=on?'#004587':'';
      el.style.borderColor=on?'#004587':'';
    });
  });

  /* ── Botão flutuante de envio ── */
  var btn=document.createElement('button');
  btn.textContent='Enviar para o professor';
  btn.style.cssText='position:fixed;bottom:20px;right:20px;z-index:9999;background:#004587;color:#fff;border:none;border-radius:12px;padding:13px 26px;font-size:14px;font-weight:700;cursor:pointer;box-shadow:0 4px 24px rgba(0,69,135,.35);font-family:inherit;letter-spacing:.01em;';
  document.body.appendChild(btn);

  btn.addEventListener('click',function(){
    if(btn.dataset.sent==='1') return;
    var data={fields:[],checkboxes:[]};
    document.querySelectorAll('.field-line,.field-line-lg').forEach(function(el){
      data.fields.push(el.innerText.trim());
    });
    document.querySelectorAll('.check-box,.chrono-check').forEach(function(el,i){
      if(el.dataset.checked==='1') data.checkboxes.push(i);
    });
    btn.textContent='Enviando...';
    btn.style.opacity='.7';
    fetch('/api/submit-activity',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({roomCode:roomCode,studentName:studentName,lessonName:lessonName,lessonUrl:lessonUrl,data:data})
    }).then(function(r){return r.json();}).then(function(j){
      if(j.ok){
        btn.textContent='Enviado com sucesso!';
        btn.style.background='#16a34a';
        btn.style.opacity='1';
        btn.dataset.sent='1';
        try{window.parent.postMessage({type:'activitySubmitted',studentName:studentName},'*');}catch(e){}
      }else{
        btn.textContent='Erro — tente novamente';
        btn.style.background='#dc2626';
        btn.style.opacity='1';
      }
    }).catch(function(){
      btn.textContent='Erro — tente novamente';
      btn.style.background='#dc2626';
      btn.style.opacity='1';
    });
  });
})();
</script>`;

// ─── HTML proxy (injeta scripts de sincronização e atividade) ─────────────────
app.get('/api/proxy-html', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).end();
  try {
    const response = await fetch(url);
    if (!response.ok) return res.status(response.status).end();
    let html = await response.text();
    const injection = SLIDE_SYNC_SCRIPT + ACTIVITY_SCRIPT;
    html = html.includes('</body>')
      ? html.replace('</body>', injection + '</body>')
      : html + injection;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (err) {
    console.error('proxy-html:', err.message);
    res.status(500).end();
  }
});

// ─── Submissão de atividades ──────────────────────────────────────────────────
app.post('/api/submit-activity', express.json(), async (req, res) => {
  const { roomCode, studentName, lessonName, lessonUrl, data } = req.body;
  if (!roomCode || !studentName || !data) return res.status(400).json({ error: 'Dados incompletos' });

  try {
    if (supabase) {
      const { error } = await supabase.from('submissions').insert({
        room_code: roomCode,
        student_name: studentName,
        lesson_name: lessonName || 'Atividade',
        lesson_url: lessonUrl || '',
        data,
      });
      if (error) throw error;
    }

    // Notifica o professor via socket (se a sala ainda estiver ativa)
    const s = sessions.get(roomCode?.toUpperCase());
    if (s?.teacherSocket) {
      io.to(s.teacherSocket).emit('activity:submitted', { studentName, lessonName });
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('submit-activity:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Consulta de submissões (professor autenticado) ───────────────────────────
app.get('/api/submissions', auth, async (req, res) => {
  const { room } = req.query;
  if (!supabase) return res.json([]);
  try {
    let q = supabase.from('submissions').select('*').order('submitted_at', { ascending: false });
    if (room) q = q.eq('room_code', room.toUpperCase());
    const { data, error } = await q.limit(200);
    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error('get-submissions:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`\n  🎓  Plataforma de Aulas — Senac Araçatuba`);
  console.log(`  🌐  http://localhost:${PORT}`);
  console.log(`  🔑  Senha do professor: ${TEACHER_PASSWORD}\n`);
});
