// 同步Notion数据到本地数据库
const { Client } = require('@notionhq/client');
const LocalDatabase = require('./local-database');
const config = require('./config.json');

// 初始化
const notion = new Client({
  auth: config.notion.apiToken
});
const DATABASE_ID = config.notion.databaseId;
const localDB = new LocalDatabase(config.localDatabase);

// 字段映射（从Notion到本地）
const fieldMapping = {
  '客户邮箱': 'email',
  '铺助邮箱': 'auxiliaryEmail',
  '铺助邮箱密码': 'auxiliaryPassword',
  '账号类型': 'accountType',
  '状态': 'status',
  '入库日期': 'inboundDate',
  '出库日期': 'outboundDate',
  '入库价格': 'inboundPrice',
  '出库价格': 'outboundPrice',
  '提交者ID': 'submitterId',
  '备注': 'notes',
  '密钥': 'password',
  '2fa密码': 'twoFaCode'
};

async function syncNotionToLocal() {
  console.log('🔄 开始同步Notion数据到本地数据库...\n');
  
  try {
    // 初始化本地数据库
    await localDB.initialize();
    
    // 备份当前数据
    console.log('📦 备份当前本地数据...');
    await localDB.backup();
    
    let hasMore = true;
    let cursor = undefined;
    let totalSynced = 0;
    let successCount = 0;
    let errorCount = 0;
    
    while (hasMore) {
      // 从Notion获取数据
      console.log('📥 从Notion获取数据...');
      const response = await notion.databases.query({
        database_id: DATABASE_ID,
        page_size: 100,
        start_cursor: cursor
      });
      
      console.log(`获取到 ${response.results.length} 条记录`);
      
      // 处理每条记录
      for (const page of response.results) {
        try {
          const properties = page.properties;
          
          // 提取数据
          const accountData = {
            notionId: page.id,
            email: getPropertyValue(properties['客户邮箱']),
            password: getPropertyValue(properties['密钥']) || getPropertyValue(properties['铺助邮箱密码']),
            auxiliaryEmail: getPropertyValue(properties['铺助邮箱']),
            auxiliaryPassword: getPropertyValue(properties['铺助邮箱密码']),
            accountType: getPropertyValue(properties['账号类型']) || '未分类',
            status: getPropertyValue(properties['状态']) || '在库',
            inboundDate: getPropertyValue(properties['入库日期']),
            outboundDate: getPropertyValue(properties['出库日期']),
            inboundPrice: parseFloat(getPropertyValue(properties['入库价格'])) || 0,
            outboundPrice: parseFloat(getPropertyValue(properties['出库价格'])) || 0,
            submitterId: getPropertyValue(properties['提交者ID']),
            submitterName: getPropertyValue(properties['提交者ID']), // 暂时使用ID作为名称
            notes: getPropertyValue(properties['备注']),
            twoFaCode: getPropertyValue(properties['2fa密码']),
            createdAt: page.created_time,
            updatedAt: page.last_edited_time
          };
          
          // 只同步有效的记录（至少有邮箱）
          if (accountData.email) {
            // 检查是否已存在
            const existing = await localDB.findAccount(accountData.email);
            
            if (existing) {
              // 更新现有记录
              Object.assign(existing, accountData);
              console.log(`✅ 更新: ${accountData.email}`);
            } else {
              // 添加新记录
              await localDB.addAccount(accountData);
              console.log(`✅ 新增: ${accountData.email}`);
            }
            successCount++;
          }
          
        } catch (error) {
          console.error(`❌ 处理记录失败:`, error.message);
          errorCount++;
        }
        
        totalSynced++;
      }
      
      hasMore = response.has_more;
      cursor = response.next_cursor;
    }
    
    // 保存数据
    await localDB.save();
    
    // 显示统计
    console.log('\n📊 同步完成统计：');
    console.log(`总处理记录：${totalSynced}`);
    console.log(`成功同步：${successCount}`);
    console.log(`失败：${errorCount}`);
    
    // 显示本地数据库统计
    const stats = await localDB.getStats();
    console.log('\n📈 本地数据库统计：');
    console.log(`总记录数：${stats.total}`);
    console.log(`在库：${stats.byStatus['在库'] || 0}`);
    console.log(`已出库：${stats.byStatus['已出库'] || 0}`);
    
    if (stats.byType) {
      console.log('\n按类型统计：');
      for (const [type, count] of Object.entries(stats.byType)) {
        console.log(`  ${type}: ${count}`);
      }
    }
    
  } catch (error) {
    console.error('❌ 同步失败:', error);
    console.error('错误详情:', error.stack);
  }
}

// 获取属性值的辅助函数
function getPropertyValue(property) {
  if (!property) return null;
  
  switch (property.type) {
    case 'title':
      return property.title?.[0]?.plain_text || null;
    case 'rich_text':
      return property.rich_text?.[0]?.plain_text || null;
    case 'number':
      return property.number;
    case 'select':
      return property.select?.name || null;
    case 'date':
      return property.date?.start || null;
    case 'email':
      return property.email || null;
    case 'phone_number':
      return property.phone_number || null;
    case 'url':
      return property.url || null;
    default:
      return null;
  }
}

// 执行同步
if (require.main === module) {
  syncNotionToLocal()
    .then(() => {
      console.log('\n✅ 同步完成！');
      process.exit(0);
    })
    .catch(error => {
      console.error('\n❌ 同步失败:', error);
      process.exit(1);
    });
}

module.exports = { syncNotionToLocal };