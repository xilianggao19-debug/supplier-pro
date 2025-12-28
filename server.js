const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const multer = require('multer');

const app = express();
const port = process.env.PORT || 3000;

// 1. 目录初始化：确保必要文件夹存在
const dirs = ['data', 'public/uploads'];
dirs.forEach(dir => {
    const fullPath = path.join(__dirname, dir);
    if (!fs.existsSync(fullPath)) {
        fs.mkdirSync(fullPath, { recursive: true });
        console.log(`创建目录: ${dir}`);
    }
});

// 2. 数据库初始化
const dbPath = path.join(__dirname, 'data/suppliers.db');
const db = new sqlite3.Database(dbPath);

db.serialize(() => {
    // 用户表
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE,
        password TEXT,
        role TEXT, -- 'admin' 或 'supplier'
        nickname TEXT
    )`);

    // 供应商资质资料表 (支持文件上传和有效期)
    db.run(`CREATE TABLE IF NOT EXISTS supplier_profiles (
        user_id INTEGER PRIMARY KEY,
        license_file TEXT,       -- 营业执照文件路径
        license_expiry DATE,     -- 营业执照有效期
        permit_file TEXT,        -- 医疗器械许可证文件路径
        permit_expiry DATE,      -- 医疗器械许可证有效期
        updated_at DATETIME,
        FOREIGN KEY(user_id) REFERENCES users(id)
    )`);

    // 订单表
    db.run(`CREATE TABLE IF NOT EXISTS orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_no TEXT,
        sku TEXT,
        name TEXT,
        spec TEXT,
        quantity INTEGER,
        unit_price REAL,
        total_price REAL,
        supplier_id INTEGER,
        status TEXT DEFAULT '待确认', -- '待确认', '已发货'
        logistics_company TEXT,
        tracking_no TEXT,
        delivery_note TEXT, -- 发货单文件路径
        test_report TEXT,   -- 质检报告文件路径
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(supplier_id) REFERENCES users(id)
    )`);

    // 初始化默认账号 (admin/123, supply/123)
    db.get("SELECT * FROM users WHERE username = 'admin'", (err, row) => {
        if (!row) {
            db.run("INSERT INTO users (username, password, role, nickname) VALUES ('admin', '123', 'admin', '系统管理员')");
            db.run("INSERT INTO users (username, password, role, nickname) VALUES ('supply', '123', 'supplier', '示范供应商')");
            console.log("默认账号已创建");
        }
    });
});

// 3. 文件上传配置 (Multer)
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, 'public/uploads/'),
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + '-' + file.originalname);
    }
});
const upload = multer({ storage });

app.use(express.json());
app.use(express.static('public'));

// --- 4. API 路由：用户认证 ---

// 登录
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    db.get("SELECT id, username, role, nickname FROM users WHERE username = ? AND password = ?", [username, password], (err, user) => {
        if (user) res.json({ success: true, user });
        else res.status(401).json({ success: false, message: '用户名或密码错误' });
    });
});

// 修改密码
app.post('/api/change-password', (req, res) => {
    const { userId, newPassword } = req.body;
    db.run("UPDATE users SET password = ? WHERE id = ?", [newPassword, userId], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

// --- 5. API 路由：仪表盘统计 ---

// 管理员仪表盘统计
app.get('/api/stats/admin', (req, res) => {
    const statsQuery = `
        SELECT 
            COUNT(*) as totalOrders,
            SUM(CASE WHEN status = '待确认' THEN 1 ELSE 0 END) as pendingOrders,
            SUM(total_price) as totalAmount
        FROM orders`;
    
    const supplierQuery = `
        SELECT u.nickname as name, SUM(o.total_price) as value, COUNT(o.id) as count
        FROM orders o 
        JOIN users u ON o.supplier_id = u.id 
        GROUP BY u.id`;

    db.get(statsQuery, (err, stats) => {
        db.all(supplierQuery, (err2, suppliers) => {
            res.json({ stats: stats || {totalOrders:0, pendingOrders:0, totalAmount:0}, suppliers: suppliers || [] });
        });
    });
});

// 供应商仪表盘统计
app.get('/api/stats/supplier/:userId', (req, res) => {
    const userId = req.params.userId;
    const statsQuery = `
        SELECT 
            COUNT(*) as totalOrders,
            SUM(CASE WHEN status = '待确认' THEN 1 ELSE 0 END) as pendingOrders,
            SUM(total_price) as totalRevenue
        FROM orders WHERE supplier_id = ?`;
    
    db.get(statsQuery, [userId], (err, stats) => {
        db.get("SELECT license_file, license_expiry FROM supplier_profiles WHERE user_id = ?", [userId], (err2, profile) => {
            res.json({ 
                stats: stats || {totalOrders:0, pendingOrders:0, totalRevenue:0}, 
                profileMissing: !profile?.license_file 
            });
        });
    });
});

// --- 6. API 路由：订单管理 ---

// 获取订单列表 (根据角色过滤)
app.get('/api/orders', (req, res) => {
    const { role, userId } = req.query;
    let query = `
        SELECT orders.*, users.nickname as supplier_name 
        FROM orders 
        JOIN users ON orders.supplier_id = users.id`;
    let params = [];

    if (role === 'supplier') {
        query += " WHERE supplier_id = ?";
        params.push(userId);
    }
    query += " ORDER BY created_at DESC";

    db.all(query, params, (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// 管理员发布订单
app.post('/api/orders', (req, res) => {
    const { order_no, sku, name, spec, quantity, unit_price, supplier_id } = req.body;
    const total = (parseFloat(quantity) * parseFloat(unit_price)) || 0;
    db.run(`INSERT INTO orders (order_no, sku, name, spec, quantity, unit_price, total_price, supplier_id) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, 
            [order_no, sku, name, spec, quantity, unit_price, total, supplier_id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true, id: this.lastID });
    });
});

// 供应商确认发货 (上传附件)
app.post('/api/orders/confirm', upload.fields([
    { name: 'note', maxCount: 1 }, 
    { name: 'report', maxCount: 1 }
]), (req, res) => {
    const { orderId, logistics_company, tracking_no } = req.body;
    const delivery_note = req.files['note'] ? '/uploads/' + req.files['note'][0].filename : '';
    const test_report = req.files['report'] ? '/uploads/' + req.files['report'][0].filename : '';

    db.run(`UPDATE orders SET status='已发货', logistics_company=?, tracking_no=?, delivery_note=?, test_report=? WHERE id=?`,
        [logistics_company, tracking_no, delivery_note, test_report, orderId], (err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true });
        });
});

// 获取所有供应商简易列表 (供下单下拉框使用)
app.get('/api/suppliers-list', (req, res) => {
    db.all("SELECT id, nickname FROM users WHERE role = 'supplier'", (err, rows) => {
        res.json(rows);
    });
});

// --- 7. API 路由：供应商资质管理 ---

// 获取资质信息
app.get('/api/profile/:userId', (req, res) => {
    db.get("SELECT * FROM supplier_profiles WHERE user_id = ?", [req.params.userId], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(row || {});
    });
});

// 维护资质 (上传文件 + 有效期)
app.post('/api/profile', upload.fields([
    { name: 'license_file', maxCount: 1 },
    { name: 'permit_file', maxCount: 1 }
]), (req, res) => {
    const { userId, license_expiry, permit_expiry } = req.body;
    
    db.get("SELECT * FROM supplier_profiles WHERE user_id = ?", [userId], (err, row) => {
        // 如果没有新上传文件，则保留旧文件路径
        const license_path = req.files['license_file'] ? '/uploads/' + req.files['license_file'][0].filename : (row ? row.license_file : null);
        const permit_path = req.files['permit_file'] ? '/uploads/' + req.files['permit_file'][0].filename : (row ? row.permit_file : null);

        db.run(`INSERT OR REPLACE INTO supplier_profiles 
                (user_id, license_file, license_expiry, permit_file, permit_expiry, updated_at) 
                VALUES (?, ?, ?, ?, ?, datetime('now'))`, 
                [userId, license_path, license_expiry, permit_path, permit_expiry], (err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true });
        });
    });
});

// 8. 启动服务器
app.listen(port, '0.0.0.0', () => {
    console.log(`------------------------------------------`);
    console.log(`SRM 系统已在云端/本地启动`);
    console.log(`监听地址: http://0.0.0.0:${port}`);
    console.log(`本地访问: http://localhost:${port}`);
    console.log(`------------------------------------------`);
});