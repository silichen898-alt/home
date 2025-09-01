const express = require('express');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const bodyParser = require('body-parser');
const AlipayService = require('./alipay-service');

const app = express();
const PORT = process.env.PORT || 3000;

// 数据库连接
const db = new sqlite3.Database(path.join(__dirname, 'card-shop.db'));

// 中间件
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static('public'));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// 首页 - 商品展示
app.get('/', (req, res) => {
    db.all(`SELECT * FROM products WHERE status = 'available' ORDER BY account_type, price`, (err, products) => {
        if (err) {
            console.error('查询商品失败:', err);
            return res.status(500).send('服务器错误');
        }
        
        // 按类型分组
        const groupedProducts = {};
        products.forEach(product => {
            if (!groupedProducts[product.account_type]) {
                groupedProducts[product.account_type] = [];
            }
            groupedProducts[product.account_type].push(product);
        });
        
        res.render('index', { 
            products: groupedProducts,
            totalCount: products.length
        });
    });
});

// 管理后台
app.get('/admin', (req, res) => {
    db.all(`SELECT * FROM products ORDER BY created_at DESC`, (err, products) => {
        if (err) {
            console.error('查询商品失败:', err);
            return res.status(500).send('服务器错误');
        }
        
        db.all(`SELECT * FROM orders ORDER BY created_at DESC`, (err, orders) => {
            if (err) {
                console.error('查询订单失败:', err);
                return res.status(500).send('服务器错误');
            }
            
            // 统计数据
            const stats = {
                totalProducts: products.length,
                availableProducts: products.filter(p => p.status === 'available').length,
                soldProducts: products.filter(p => p.status === 'sold').length,
                totalOrders: orders.length,
                pendingOrders: orders.filter(o => o.payment_status === 'pending').length,
                completedOrders: orders.filter(o => o.payment_status === 'completed').length,
                totalRevenue: orders.filter(o => o.payment_status === 'completed')
                    .reduce((sum, order) => sum + order.amount, 0)
            };
            
            res.render('admin', { 
                products, 
                orders, 
                stats 
            });
        });
    });
});

// API: 获取商品详情
app.get('/api/product/:id', (req, res) => {
    const productId = req.params.id;
    
    db.get(`SELECT * FROM products WHERE id = ? AND status = 'available'`, [productId], (err, product) => {
        if (err) {
            return res.status(500).json({ error: '查询失败' });
        }
        
        if (!product) {
            return res.status(404).json({ error: '商品不存在或已售出' });
        }
        
        res.json(product);
    });
});

// API: 创建订单
app.post('/api/order', (req, res) => {
    const { productId, buyerContact, paymentMethod, usdtNetwork } = req.body;
    
    if (!productId || !buyerContact || !paymentMethod) {
        return res.status(400).json({ error: '缺少必要参数' });
    }
    
    // 检查商品是否可用
    db.get(`SELECT * FROM products WHERE id = ? AND status = 'available'`, [productId], (err, product) => {
        if (err) {
            return res.status(500).json({ error: '查询商品失败' });
        }
        
        if (!product) {
            return res.status(400).json({ error: '商品不存在或已售出' });
        }
        
        // 生成订单号
        const orderNo = 'ORD' + Date.now() + Math.random().toString(36).substr(2, 5).toUpperCase();
        
        // 创建订单
        db.run(`INSERT INTO orders (order_no, product_id, buyer_contact, amount, payment_method, payment_status, delivery_status) 
                VALUES (?, ?, ?, ?, ?, 'pending', 'pending')`, 
                [orderNo, productId, buyerContact, product.price, paymentMethod], function(err) {
            if (err) {
                return res.status(500).json({ error: '创建订单失败' });
            }
            
            // 锁定商品（可选，防止重复购买）
            // db.run(`UPDATE products SET status = 'reserved' WHERE id = ?`, [productId]);
            
            const orderData = {
                order_no: orderNo,
                order_id: this.lastID,
                product_id: productId,
                total_amount: product.price,
                payment_method: paymentMethod,
                usdt_network: usdtNetwork,
                product: product
            };
            
            // 生成支付详情
            const paymentDetails = generateSimplePaymentDetails(paymentMethod, orderData);
            
            res.json({
                success: true,
                order: orderData,
                paymentDetails: paymentDetails
            });
        });
    });
});

// API: 确认支付
app.post('/api/payment/confirm', (req, res) => {
    const { orderNo } = req.body;
    
    if (!orderNo) {
        return res.status(400).json({ error: '订单号不能为空' });
    }
    
    db.get(`SELECT o.*, p.* FROM orders o 
            JOIN products p ON o.product_id = p.id 
            WHERE o.order_no = ?`, [orderNo], (err, order) => {
        if (err) {
            return res.status(500).json({ error: '查询订单失败' });
        }
        
        if (!order) {
            return res.status(404).json({ error: '订单不存在' });
        }
        
        // 更新订单状态
        db.run(`UPDATE orders SET payment_status = 'completed', delivery_status = 'completed' WHERE order_no = ?`, 
               [orderNo], (err) => {
            if (err) {
                return res.status(500).json({ error: '更新订单状态失败' });
            }
            
            // 更新商品状态为已售
            db.run(`UPDATE products SET status = 'sold' WHERE id = ?`, [order.product_id], (err) => {
                if (err) {
                    console.error('更新商品状态失败:', err);
                }
                
                res.json({
                    success: true,
                    message: '支付确认成功',
                    accountInfo: {
                        email: order.email,
                        password: order.password,
                        auxiliaryEmail: order.auxiliary_email,
                        twoFACode: order.two_fa_code,
                        accountKey: order.account_key
                    }
                });
            });
        });
    });
});

// API: 获取统计数据
app.get('/api/stats', (req, res) => {
    db.all(`SELECT account_type, status, COUNT(*) as count FROM products GROUP BY account_type, status`, (err, stats) => {
        if (err) {
            return res.status(500).json({ error: '查询统计失败' });
        }
        
        res.json(stats);
    });
});

// 错误处理
app.use((err, req, res, next) => {
    console.error('服务器错误:', err);
    res.status(500).send('服务器内部错误');
});

// 简单支付详情生成
function generateSimplePaymentDetails(method, orderData) {
    if (method === 'alipay') {
        return `
            <div class="payment-info">
                <h4><i class="fab fa-alipay"></i> 支付宝付款</h4>
                <div class="payment-details">
                    <p><strong>收款账号:</strong> your_alipay@example.com</p>
                    <p><strong>支付金额:</strong> ¥${orderData.total_amount}</p>
                    <p><strong>订单号:</strong> ${orderData.order_no}</p>
                    <p style="color: #ff9800; font-weight: bold;">
                        <i class="fas fa-exclamation-triangle"></i>
                        重要：请在支付备注中填写订单号
                    </p>
                </div>
            </div>
        `;
    } else if (method === 'usdt') {
        return `
            <div class="payment-info">
                <h4><i class="fab fa-bitcoin"></i> USDT付款</h4>
                <div class="payment-details">
                    <p><strong>收款地址:</strong> TXXXXxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx</p>
                    <p><strong>网络:</strong> TRC20</p>
                    <p><strong>支付金额:</strong> ¥${orderData.total_amount} (请按当前汇率转换为USDT)</p>
                    <p><strong>订单号:</strong> ${orderData.order_no}</p>
                    <p style="color: #ff9800; font-weight: bold;">
                        <i class="fas fa-exclamation-triangle"></i>
                        重要：转账时请在备注中填写订单号
                    </p>
                </div>
            </div>
        `;
    }
    return '<p>不支持的支付方式</p>';
}

// 启动服务器
app.listen(PORT, () => {
    console.log(`🚀 Gmail卡网系统已启动`);
    console.log(`📱 前端商城: http://localhost:${PORT}`);
    console.log(`💼 管理后台: http://localhost:${PORT}/admin`);
    console.log(`🎯 API文档: http://localhost:${PORT}/api`);
    console.log('======================================');
});

// 优雅关闭
process.on('SIGINT', () => {
    console.log('\n正在关闭服务器...');
    db.close((err) => {
        if (err) {
            console.error('关闭数据库连接失败:', err);
        } else {
            console.log('✅ 数据库连接已关闭');
        }
        process.exit(0);
    });
});