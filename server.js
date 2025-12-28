const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const jwt = require('jsonwebtoken');

const app = express();
const port = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'srm-secret-key-2025';

// 1. 目录初始化
const dirs = ['data', 'public/uploads'];
dirs.forEach(dir => {
    const fullPath = path.join(__dirname, dir);
    if (!fs.existsSync(fullPath)) fs.mkdirSync(fullPath, { recursive: true });
});

// 2. 数据库初始化
const dbPath = path.join(__dirname, 'data', 'suppliers.db');
const db = new sqlite3.Database(dbPath);

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE, password TEXT, role TEXT, nickname TEXT, status INTEGER DEFAULT 1)`);
    db.run(`CREATE TABLE IF NOT EXISTS products (id INTEGER PRIMARY KEY AUTOINCREMENT, sku TEXT UNIQUE, name TEXT, spec TEXT, unit_price REAL)`);
    db.run(`CREATE TABLE IF NOT EXISTS orders (id INTEGER PRIMARY KEY AUTOINCREMENT, order_no TEXT, sku TEXT, name TEXT, spec TEXT, quantity INTEGER, unit_price REAL, total_price REAL, supplier_id INTEGER, status TEXT DEFAULT '待确认', logistics_company TEXT, tracking_no TEXT, delivery_note TEXT, test_report TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);

    db.get("SELECT * FROM users WHERE username = 'admin'", (err, row) => {
        if (!row) {
            db.run("INSERT INTO users (username, password, role, nickname) VALUES ('admin', '123', 'admin', '系统管理员')");
            db.run("INSERT INTO users (username, password, role, nickname) VALUES ('supply', '123', 'supplier', '示范供应商')");
        }
    });
});

// 3. 鉴权中间件
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ message: '未登录' });
    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ message: '登录失效' });
        req.user = user;
        next();
    });
};

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, 'public/uploads/'),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage });

app.use(express.json());
app.use(express.static('public'));

// --- API 接口 ---

app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    db.get("SELECT * FROM users WHERE username = ? AND password = ?", [username, password], (err, user) => {
        if (!user) return res.status(401).json({ message: '账号或密码错误' });
        if (user.status === 0) return res.status(403).json({ message: '账号已禁用' });
        const token = jwt.sign({ id: user.id, role: user.role, nickname: user.nickname }, JWT_SECRET, { expiresIn: '24h' });
        res.json({ success: true, token, user: { id: user.id, role: user.role, nickname: user.nickname } });
    });
});

app.get('/api/products', authenticateToken, (req, res) => {
    db.all("SELECT * FROM products", (err, rows) => res.json(rows || []));
});

app.post('/api/products', authenticateToken, (req, res) => {
    const { sku, name, spec, unit_price } = req.body;
    db.run(`INSERT OR REPLACE INTO products (sku, name, spec, unit_price) VALUES (?, ?, ?, ?)`, [sku, name, spec, unit_price], () => res.json({ success: true }));
});

app.delete('/api/products/:id', authenticateToken, (req, res) => {
    db.run("DELETE FROM products WHERE id = ?", req.params.id, () => res.json({ success: true }));
});

app.get('/api/orders', authenticateToken, (req, res) => {
    let sql = `SELECT o.*, u.nickname as supplier_name FROM orders o JOIN users u ON o.supplier_id = u.id`;
    let params = [];
    if (req.user.role === 'supplier') { sql += " WHERE o.supplier_id = ?"; params.push(req.user.id); }
    sql += " ORDER BY o.id DESC";
    db.all(sql, params, (err, rows) => res.json(rows || []));
});

app.post('/api/orders', authenticateToken, (req, res) => {
    const { order_no, sku, name, spec, quantity, unit_price, supplier_id } = req.body;
    const total = (quantity || 0) * (unit_price || 0);
    db.run(`INSERT INTO orders (order_no, sku, name, spec, quantity, unit_price, total_price, supplier_id) VALUES (?,?,?,?,?,?,?,?)`,
        [order_no, sku, name, spec, quantity, unit_price, total, supplier_id], () => res.json({ success: true }));
});

app.post('/api/orders/receive', authenticateToken, (req, res) => {
    db.run("UPDATE orders SET status='已完成' WHERE id=?", [req.body.id], () => res.json({ success: true }));
});

app.get('/api/stats/admin', authenticateToken, (req, res) => {
    const q1 = `SELECT COUNT(*) as total, SUM(CASE WHEN status='待确认' THEN 1 ELSE 0 END) as pending, SUM(total_price) as amount FROM orders`;
    const q2 = `SELECT u.nickname as name, SUM(o.total_price) as value FROM orders o JOIN users u ON o.supplier_id = u.id GROUP BY u.id`;
    db.get(q1, (err, stats) => {
        db.all(q2, (err2, chart) => res.json({ stats: stats || {total:0, pending:0, amount:0}, chart: chart || [] }));
    });
});

app.get('/api/suppliers-list', authenticateToken, (req, res) => {
    db.all("SELECT id, nickname FROM users WHERE role = 'supplier' AND status = 1", (err, rows) => res.json(rows || []));
});

app.get('/api/admin/users', authenticateToken, (req, res) => {
    db.all("SELECT id, username, role, nickname, status FROM users WHERE role != 'admin'", (err, rows) => res.json(rows || []));
});

app.post('/api/admin/users', authenticateToken, (req, res) => {
    const { username, password, nickname } = req.body;
    db.run("INSERT INTO users (username, password, role, nickname) VALUES (?, ?, 'supplier', ?)", [username, password, nickname], (err) => {
        if (err) return res.status(400).json({ message: '用户名已存在' });
        res.json({ success: true });
    });
});

app.post('/api/admin/users/update', authenticateToken, (req, res) => {
    const { id, password, status } = req.body;
    if (password) db.run("UPDATE users SET password = ? WHERE id = ?", [password, id], () => res.json({ success: true }));
    else db.run("UPDATE users SET status = ? WHERE id = ?", [status, id], () => res.json({ success: true }));
});

app.post('/api/user/change-password', authenticateToken, (req, res) => {
    db.run("UPDATE users SET password = ? WHERE id = ?", [req.body.newPassword, req.user.id], () => res.json({ success: true }));
});

app.listen(port, '0.0.0.0', () => console.log(`系统就绪：端口 ${port}`));