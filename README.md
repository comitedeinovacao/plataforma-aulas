# Plataforma de Aulas — Senac Araçatuba

Plataforma interativa de aulas ao vivo, similar ao Lumio/Smarttech.

## Funcionalidades

- Upload de aulas em PDF ou HTML
- Apresentação fullscreen com sincronização de slides em tempo real
- Alunos entram sem cadastro, apenas com nome + código da sala
- Quiz ao vivo com resultados em tempo real
- Ferramentas de desenho (caneta, borracha, cores)
- QR Code para acesso dos alunos

## Uso local

```bash
cd backend
npm install
node server.js
# Acesse http://localhost:3000
```

**Senha padrão do professor:** `senac2025`  
(Altere via variável de ambiente `TEACHER_PASSWORD`)

## Deploy (Render.com)

1. Suba o repositório no GitHub
2. Crie uma conta em [render.com](https://render.com)
3. New → Web Service → conecte o repositório
4. Root Directory: `backend`
5. Build Command: `npm install`
6. Start Command: `node server.js`
7. Em Environment Variables, defina `TEACHER_PASSWORD` com sua senha

## Tecnologias

- Node.js + Express + Socket.io
- PDF.js (renderização de PDF no browser)
- HTML/CSS/JS puro (sem frameworks)
- Design System: paleta oficial Senac (#004587 / #F7941D)

---

Desenvolvido por Jean Carlos Macedo — Senac Araçatuba
