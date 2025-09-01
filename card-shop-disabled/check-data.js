const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const db = new sqlite3.Database(path.join(__dirname, 'card-shop.db'));

console.log('🔍 查看卡网数据库内容:');
console.log('==============================================');

db.all('SELECT * FROM products ORDER BY created_at DESC', (err, rows) => {
  if (err) {
    console.error('查询失败:', err);
  } else {
    console.log(`📊 总计: ${rows.length} 个账号\n`);
    
    rows.forEach((row, index) => {
      console.log(`${index + 1}. 📧 ${row.email}`);
      console.log(`   🔑 密码: ${row.password}`);
      console.log(`   📦 类型: ${row.account_type}`);
      console.log(`   💰 价格: $${row.price}`);
      console.log(`   📮 辅助邮箱: ${row.auxiliary_email || 'N/A'}`);
      console.log(`   🔐 2FA: ${row.two_fa_code || 'N/A'}`);
      console.log(`   🔓 API Key: ${row.account_key ? row.account_key.substring(0, 20) + '...' : 'N/A'}`);
      console.log(`   ⚡ 状态: ${row.status}`);
      console.log(`   📅 创建时间: ${row.created_at}`);
      console.log('');
    });

    // 统计信息
    const available = rows.filter(r => r.status === 'available').length;
    const sold = rows.filter(r => r.status === 'sold').length;
    
    console.log('📈 统计信息:');
    console.log(`   ✅ 可售: ${available} 个`);
    console.log(`   ❌ 已售: ${sold} 个`);
    
    // 按类型统计
    const typeStats = {};
    rows.forEach(row => {
      typeStats[row.account_type] = (typeStats[row.account_type] || 0) + 1;
    });
    
    console.log('\n📦 按类型统计:');
    Object.keys(typeStats).forEach(type => {
      console.log(`   ${type}: ${typeStats[type]} 个`);
    });
    
    console.log('==============================================');
  }
  
  db.close();
});