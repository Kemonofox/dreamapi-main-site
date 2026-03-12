require('dotenv').config()
const express    = require('express')
const session    = require('express-session')
const { Octokit } = require('@octokit/rest')
const crypto     = require('crypto')
const path       = require('path')

const app  = express()
const PORT = process.env.PORT || 3000

const GITHUB_TOKEN = process.env.GITHUB_TOKEN
const GITHUB_OWNER = process.env.GITHUB_OWNER
const GITHUB_REPO  = process.env.GITHUB_REPO   // private repo

const octokit = new Octokit({ auth: GITHUB_TOKEN })

// ── Middleware ──────────────────────────────────────────────────────────────
app.use(express.json())
app.use(express.urlencoded({ extended: true }))
app.use(express.static(path.join(__dirname, 'public')))
app.use(session({
  secret: process.env.SESSION_SECRET || 'dreamapi-dev-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 } // 24h
}))

// ── Auth Middleware ─────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (req.session.user) return next()
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Unauthorized' })
  res.redirect('/login')
}

// ── GitHub Helpers ──────────────────────────────────────────────────────────
async function getFile(filePath) {
  const { data } = await octokit.repos.getContent({
    owner: GITHUB_OWNER,
    repo:  GITHUB_REPO,
    path:  filePath,
  })
  const content = Buffer.from(data.content, 'base64').toString('utf-8')
  return { content: JSON.parse(content), sha: data.sha }
}

async function saveFile(filePath, content, sha, message) {
  await octokit.repos.createOrUpdateFileContents({
    owner:   GITHUB_OWNER,
    repo:    GITHUB_REPO,
    path:    filePath,
    message,
    content: Buffer.from(JSON.stringify(content, null, 2)).toString('base64'),
    sha,
  })
}

function sha256(str) {
  return crypto.createHash('sha256').update(str).digest('hex')
}

// ── Page Routes ─────────────────────────────────────────────────────────────
app.get('/',          (req, res) => res.sendFile(path.join(__dirname, 'public/index.html')))
app.get('/login',     (req, res) => res.sendFile(path.join(__dirname, 'public/login.html')))
app.get('/docs',      (req, res) => res.sendFile(path.join(__dirname, 'public/docs.html')))
app.get('/dashboard', requireAuth, (req, res) => res.sendFile(path.join(__dirname, 'public/dashboard.html')))

// ── Auth API ────────────────────────────────────────────────────────────────
app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body
    if (!username || !password)
      return res.status(400).json({ error: '아이디와 비밀번호를 입력하십시오.' })

    const { content: accounts } = await getFile('accounts.json')
    const user = accounts.find(
      a => a.username === username && a.password === sha256(password)
    )

    if (!user)
      return res.status(401).json({ error: '아이디 또는 비밀번호가 올바르지 않습니다.' })

    req.session.user = { username: user.username }
    res.json({ ok: true, username: user.username })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: '서버 오류가 발생했습니다.' })
  }
})

app.post('/api/logout', (req, res) => {
  req.session.destroy()
  res.json({ ok: true })
})

app.get('/api/me', (req, res) => {
  if (req.session.user) res.json(req.session.user)
  else res.status(401).json({ error: 'Unauthorized' })
})

// ── APIs (Public — docs page) ───────────────────────────────────────────────
// GET /api/apis?search=&limit=10&offset=0
app.get('/api/apis', async (req, res) => {
  try {
    const { search = '', limit = 10, offset = 0 } = req.query
    const { content: apis } = await getFile('apis.json')

    let list = [...apis].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))

    if (search.trim()) {
      const q = search.toLowerCase()
      list = list.filter(a =>
        a.name.toLowerCase().includes(q) ||
        a.endpoint.toLowerCase().includes(q) ||
        (a.docs || '').toLowerCase().includes(q)
      )
    }

    res.json({
      total: list.length,
      items: list.slice(Number(offset), Number(offset) + Number(limit)),
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: '서버 오류가 발생했습니다.' })
  }
})

// GET /api/apis/:id
app.get('/api/apis/:id', async (req, res) => {
  try {
    const { content: apis } = await getFile('apis.json')
    const api = apis.find(a => a.id === req.params.id)
    if (!api) return res.status(404).json({ error: 'Not found' })
    res.json(api)
  } catch (err) {
    res.status(500).json({ error: '서버 오류가 발생했습니다.' })
  }
})

// ── APIs (Protected — dashboard) ────────────────────────────────────────────
// POST /api/apis
app.post('/api/apis', requireAuth, async (req, res) => {
  try {
    const { name, endpoint, docs = '' } = req.body
    if (!name?.trim() || !endpoint?.trim())
      return res.status(400).json({ error: 'API 이름과 엔드포인트를 입력하십시오.' })

    const { content: apis, sha } = await getFile('apis.json')
    const newApi = {
      id:        crypto.randomBytes(8).toString('hex'),
      name:      name.trim(),
      endpoint:  endpoint.trim(),
      docs,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    apis.unshift(newApi)
    await saveFile('apis.json', apis, sha, `Add API: ${name}`)
    res.json(newApi)
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: '서버 오류가 발생했습니다.' })
  }
})

// PUT /api/apis/:id
app.put('/api/apis/:id', requireAuth, async (req, res) => {
  try {
    const { name, endpoint, docs = '' } = req.body
    if (!name?.trim() || !endpoint?.trim())
      return res.status(400).json({ error: 'API 이름과 엔드포인트를 입력하십시오.' })

    const { content: apis, sha } = await getFile('apis.json')
    const idx = apis.findIndex(a => a.id === req.params.id)
    if (idx === -1) return res.status(404).json({ error: 'Not found' })

    apis[idx] = {
      ...apis[idx],
      name:      name.trim(),
      endpoint:  endpoint.trim(),
      docs,
      updatedAt: new Date().toISOString(),
    }
    await saveFile('apis.json', apis, sha, `Update API: ${name}`)
    res.json(apis[idx])
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: '서버 오류가 발생했습니다.' })
  }
})

// DELETE /api/apis/:id
app.delete('/api/apis/:id', requireAuth, async (req, res) => {
  try {
    const { content: apis, sha } = await getFile('apis.json')
    const api = apis.find(a => a.id === req.params.id)
    if (!api) return res.status(404).json({ error: 'Not found' })

    const filtered = apis.filter(a => a.id !== req.params.id)
    await saveFile('apis.json', filtered, sha, `Delete API: ${api.name}`)
    res.json({ ok: true })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: '서버 오류가 발생했습니다.' })
  }
})

// ── Start ───────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`DreamAPI server → http://localhost:${PORT}`)
})
