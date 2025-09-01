const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const db = new sqlite3.Database(path.join(__dirname, 'card-shop.db'));

console.log('🚀 初始化卡网数据库...');

// 创建products表
db.run(`CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  password TEXT NOT NULL,
  account_type TEXT NOT NULL,
  price REAL NOT NULL,
  auxiliary_email TEXT,
  two_fa_code TEXT,
  account_key TEXT,
  status TEXT DEFAULT 'available',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`, function(err) {
  if (err) {
    console.error('❌ 创建products表失败:', err.message);
  } else {
    console.log('✅ products表创建成功');
    
    // 添加测试数据
    const testAccounts = [
      {
        email: 'gmail001@gmail.com',
        password: 'GmailPass123',
        account_type: 'GMAIL',
        price: 8.00,
        auxiliary_email: 'gmail001backup@temp.com',
        two_fa_code: 'GMAILFA1',
        account_key: 'AIzaSyGmail0123456789012345678901234567',
        status: 'available'
      },
      {
        email: 'gmail002@gmail.com', 
        password: 'GmailPass456',
        account_type: 'GMAIL',
        price: 8.50,
        auxiliary_email: 'gmail002backup@temp.com',
        two_fa_code: 'GMAILFA2',
        account_key: 'AIzaSyGmail1234567890123456789012345678',
        status: 'available'
      },
      {
        email: 'aws001@gmail.com',
        password: 'AwsPass123',
        account_type: 'AWS',
        price: 25.00,
        auxiliary_email: 'aws001backup@temp.com',
        two_fa_code: 'AWSFA001',
        account_key: 'AKIA1234567890ABCDEF',
        status: 'available'
      },
      {
        email: 'aws002@gmail.com',
        password: 'AwsPass456',
        account_type: 'AWS', 
        price: 26.50,
        auxiliary_email: 'aws002backup@temp.com',
        two_fa_code: 'AWSFA002',
        account_key: 'AKIA0987654321FEDCBA',
        status: 'available'
      },
      {
        email: 'azure001@gmail.com',
        password: 'AzurePass123',
        account_type: 'AZURE',
        price: 20.00,
        auxiliary_email: 'azure001backup@temp.com',
        two_fa_code: 'AZUREFA1',
        account_key: 'azure-subscription-key-12345',
        status: 'available'
      },
      {
        email: 'azure002@gmail.com',
        password: 'AzurePass456', 
        account_type: 'AZURE',
        price: 22.00,
        auxiliary_email: 'azure002backup@temp.com',
        two_fa_code: 'AZUREFA2',
        account_key: 'azure-subscription-key-67890',
        status: 'available'
      }
    ];

    const stmt = db.prepare(`INSERT OR REPLACE INTO products (
      email, password, account_type, price, auxiliary_email, 
      two_fa_code, account_key, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`);

    testAccounts.forEach((account, index) => {
      stmt.run([
        account.email,
        account.password,
        account.account_type,
        account.price,
        account.auxiliary_email,
        account.two_fa_code,
        account.account_key,
        account.status
      ], function(err) {
        if (err) {
          console.error(`❌ 添加第${index + 1}个账号失败:`, err.message);
        } else {
          console.log(`✅ 添加第${index + 1}个账号: ${account.email} (${account.account_type})`);
        }
      });
    });

    stmt.finalize((err) => {
      if (err) {
        console.error('❌ 操作完成时出错:', err.message);
      } else {
        console.log('\n🎉 数据库初始化完成！已添加6个测试账号:');
        console.log('   📧 GMAIL: 2个 ($8.00-$8.50)');
        console.log('   ☁️ AWS: 2个 ($25.00-$26.50)');  
        console.log('   🔷 AZURE: 2个 ($20.00-$22.00)');
        console.log('\n💡 现在可以启动卡网服务进行本地测试了！');
      }
      
      db.close();
    });
  }
});

// 创建orders表
db.run(`CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_no TEXT UNIQUE NOT NULL,
  product_id INTEGER NOT NULL,
  buyer_contact TEXT NOT NULL,
  amount REAL NOT NULL,
  payment_method TEXT NOT NULL,
  payment_status TEXT DEFAULT 'pending',
  delivery_status TEXT DEFAULT 'pending',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (product_id) REFERENCES products (id)
)`, function(err) {
  if (err) {
    console.error('❌ 创建orders表失败:', err.message);
  } else {
    console.log('✅ orders表创建成功');
  }
});