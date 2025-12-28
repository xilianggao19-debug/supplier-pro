const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const multer = require('multer');

const app = express();
const port = process.env.PORT || 3000;

// 1. 目录初始化
const dirs = ['data', 'public/uploads'];
dirs.forEach(dir => {
    const fullPath = path.join(__dirname, dir);
    if (!fs.existsSync(fullPath)) {
        fs.mkdirSync(fullPath, { recursive: true });
    }
});

// 2. 数据库初始化
const dbPath = path.join(__dirname, 'data', 'suppliers.db');
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) console.error('DB Error:', err.message);
    else console.log('已连接永久数据库: ' + dbPath);
});

db.serialize(() => {
    // 用户表
    db.run(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE, password TEXT, role TEXT, nickname TEXT)`);
    // 产品表 (SKU库)
    db.run(`CREATE TABLE IF NOT EXISTS products (id INTEGER PRIMARY KEY AUTOINCREMENT, sku TEXT UNIQUE, name TEXT, spec TEXT, unit_price REAL)`);
    // 资质表
    db.run(`CREATE TABLE IF NOT EXISTS supplier_profiles (user_id INTEGER PRIMARY KEY, license_file TEXT, license_expiry DATE, permit_file TEXT, permit_expiry DATE, updated_at DATETIME)`);
    // 订单表 (增加完成状态)
    db.run(`CREATE TABLE IF NOT EXISTS orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT, order_no TEXT, sku TEXT, name TEXT, spec TEXT, 
        quantity INTEGER, unit_price REAL, total_price REAL, supplier_id INTEGER, 
        status TEXT DEFAULT '待确认', logistics_company TEXT, tracking_no TEXT, 
        delivery_note TEXT, test_report TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // 初始化默认数据
    db.get("SELECT * FROM users WHERE username = 'admin'", (err, row) => {
        if (!row) {
            db.run("INSERT INTO users (username, password, role, nickname) VALUES ('admin', '123', 'admin', '系统管理员')");
            db.run("INSERT INTO users (username, password, role, nickname) VALUES ('supply', '123', 'supplier', '中科供应有限公司')");
            db.run("INSERT OR IGNORE INTO products (sku, name, spec, unit_price) VALUES ('SKU001', '医用防护服', 'XL/175', 45.5), ('SKU002', 'N95口罩', '独立包装', 2.8)");
        }
    });
});

// 3. 上传配置
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, 'public/uploads/'),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage });

app.use(express.json());
app.use(express.static('public'));

// --- API 路由 ---

// 用户认证
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    db.get("SELECT id, username, role, nickname FROM users WHERE username = ? AND password = ?", [username, password], (err, user) => {
        if (user) res.json({ success: true, user });
        else res.status(401).json({ success: false, message: '账号或密码错误' });
    });
});

// 产品库管理 (SKU)
app.get('/api/products', (req, res) => {
    db.all("SELECT * FROM products", (err, rows) => res.json(rows));
});
app.post('/api/products', (req, res) => {
    const { sku, name, spec, unit_price } = req.body;
    db.run(`INSERT OR REPLACE INTO products (sku, name, spec, unit_price) VALUES (?, ?, ?, ?)`, [sku, name, spec, unit_price], () => res.json({ success: true }));
});
app.delete('/api/products/:id', (req, res) => {
    db.run("DELETE FROM products WHERE id = ?", req.params.id, () => res.json({ success: true }));
});

// 订单统计升级
app.get('/api/stats/admin', (req, res) => {
    const q1 = `SELECT COUNT(*) as total, SUM(CASE WHEN status='待确认' THEN 1 ELSE 0 END) as pending, SUM(total_price) as amount FROM orders`;
    const q2 = `SELECT u.nickname as name, SUM(o.total_price) as value FROM orders o JOIN users u ON o.supplier_id = u.id GROUP BY u.id`;
    db.get(q1, (err, stats) => {
        db.all(q2, (err2, chart) => res.json({ stats, chart }));
    });
});

// 订单操作：下单
app.post('/api/orders', (req, res) => {
    const { order_no, sku, name, spec, quantity, unit_price, supplier_id } = req.body;
    const total = quantity * unit_price;
    db.run(`INSERT INTO orders (order_no, sku, name, spec, quantity, unit_price, total_price, supplier_id) VALUES (?,?,?,?,?,?,?,?)`,
        [order_no, sku, name, spec, quantity, unit_price, total, supplier_id], function() { res.json({ success: true }); });
});

// 订单操作：确认收货 (管理员)
app.post('/api/orders/receive', (req, res) => {
    db.run("UPDATE orders SET status='已完成' WHERE id=?", [req.body.id], () => res.json({ success: true }));
});

// 订单操作：确认发货 (供应商)
app.post('/api/orders/confirm', upload.fields([{ name: 'note' }, { name: 'report' }]), (req, res) => {
    const { orderId, logistics_company, tracking_no } = req.body;
    const note = req.files['note'] ? '/uploads/' + req.files['note'][0].filename : '';
    const report = req.files['report'] ? '/uploads/' + req.files['report'][0].filename : '';
    db.run(`UPDATE orders SET status='已发货', logistics_company=?, tracking_no=?, delivery_note=?, test_report=? WHERE id=?`,
        [logistics_company, tracking_no, note, report, orderId], () => res.json({ success: true }));
});

// 常用获取接口
app.get('/api/orders', (req, res) => {
    const { role, userId } = req.query;
    let sql = `SELECT o.*, u.nickname as supplier_name FROM orders o JOIN users u ON o.supplier_id = u.id`;
    let params = [];
    if (role === 'supplier') { sql += " WHERE o.supplier_id = ?"; params.push(userId); }
    sql += " ORDER BY o.id DESC";
    db.all(sql, params, (err, rows) => res.json(rows));
});

app.get('/api/suppliers-list', (req, res) => {
    db.all("SELECT id, nickname FROM users WHERE role = 'supplier'", (err, rows) => res.json(rows));
});

app.listen(port, '0.0.0.0', () => console.log(`系统就绪：端口 ${port}`));