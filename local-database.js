// 本地数据库模块 - 使用JSON文件存储账号数据
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// 生成唯一ID
function generateId() {
  return crypto.randomBytes(16).toString('hex');
}

class LocalDatabase {
  constructor(config) {
    this.config = config || {
      enabled: true,
      path: './local-db/accounts.json',
      windowsPath: 'C:\\Users\\LENOVO\\Desktop\\新建文件夹 (2)\\accounts.json',
      backupEnabled: true,
      backupInterval: 'daily',
      maxBackups: 7
    };
    
    // 使用配置的路径
    this.dbPath = this.config.path;
    this.dbDir = path.dirname(this.dbPath);
    
    // 初始化数据结构
    this.data = {
      accounts: [],
      metadata: {
        lastSync: new Date().toISOString(),
        totalAccounts: 0,
        version: '1.0.0'
      }
    };
    
    this.initialized = false;
  }
  
  // 初始化数据库
  initialize() {
    if (!this.config.enabled) {
      console.log('[本地数据库] 功能已禁用');
      return;
    }
    
    try {
      // 确保目录存在
      if (!fs.existsSync(this.dbDir)) {
        fs.mkdirSync(this.dbDir, { recursive: true });
      }
      
      // 尝试读取现有数据
      if (fs.existsSync(this.dbPath)) {
        try {
          const data = fs.readFileSync(this.dbPath, 'utf8');
          const parsedData = JSON.parse(data);
          
          // 验证数据结构
          if (parsedData && parsedData.accounts && Array.isArray(parsedData.accounts)) {
            this.data = parsedData;
            console.log(`[本地数据库] 加载成功，共 ${this.data.accounts.length} 条记录`);
          } else {
            throw new Error('数据结构无效');
          }
        } catch (error) {
          console.error('[本地数据库] 读取文件失败:', error);
          // 文件损坏，重置为默认数据
          this.data = {
            accounts: [],
            metadata: {
              lastSync: new Date().toISOString(),
              totalAccounts: 0,
              version: '1.0.0'
            }
          };
          this.saveSync();
          console.log('[本地数据库] 创建新数据库文件');
        }
      } else {
        // 文件不存在，使用默认数据并创建新文件
        this.data = {
          accounts: [],
          metadata: {
            lastSync: new Date().toISOString(),
            totalAccounts: 0,
            version: '1.0.0'
          }
        };
        this.saveSync();
        console.log('[本地数据库] 创建新数据库文件');
      }
      
      this.initialized = true;
      
      // 启动自动备份
      if (this.config.backupEnabled) {
        this.startAutoBackup();
      }
    } catch (error) {
      console.error('[本地数据库] 初始化失败:', error);
      throw error;
    }
  }
  
  // 同步保存数据到文件
  saveSync() {
    if (!this.config.enabled) return;
    
    try {
      // 确保metadata存在
      if (!this.data.metadata) {
        this.data.metadata = {
          lastSync: new Date().toISOString(),
          totalAccounts: 0,
          version: '1.0.0'
        };
      }
      
      // 更新元数据
      this.data.metadata.lastSync = new Date().toISOString();
      this.data.metadata.totalAccounts = this.data.accounts.length;
      
      // 写入文件
      fs.writeFileSync(this.dbPath, JSON.stringify(this.data, null, 2), 'utf8');
      console.log(`[本地数据库] 保存成功，共 ${this.data.accounts.length} 条记录`);
    } catch (error) {
      console.error('[本地数据库] 保存失败:', error);
      throw error;
    }
  }
  
  // 异步保存数据到文件
  async save() {
    this.saveSync();
  }
  
  // 添加账号
  async addAccount(accountData) {
    if (!this.config.enabled) return;
    
    const account = {
      id: generateId(),
      email: accountData.email,
      accountType: accountData.account_type || accountData.accountType || '未分类',
      status: accountData.status || '在库',
      inboundDate: accountData.inboundDate || new Date().toISOString().split('T')[0],
      inboundPrice: accountData.inboundPrice || accountData.price || 0,
      outboundDate: accountData.outboundDate || null,
      outboundPrice: accountData.outboundPrice || null,
      reinboundDate: accountData.reinboundDate || null,
      reinboundPrice: accountData.reinboundPrice || null,
      reinboundUserId: accountData.reinboundUserId || null,
      reinboundUserName: accountData.reinboundUserName || null,
      auxiliaryEmail: accountData.auxiliary_email || accountData.auxiliaryEmail || '',
      auxiliaryPassword: accountData.auxiliary_email_password || accountData.auxiliaryPassword || '',
      twoFACode: accountData.two_fa_code || accountData.twoFACode || '',
      emailPassword: accountData.email_password || accountData.emailPassword || '',
      accountKey: accountData.account_key || accountData.accountKey || '',
      submitterId: accountData.submitterId || '',
      submitterName: accountData.submitterName || '',
      notes: accountData.notes || '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    
    // 检查重复
    const existing = this.data.accounts.find(acc => acc.email === account.email);
    if (existing) {
      console.log(`[本地数据库] 账号已存在: ${account.email}`);
      return existing;
    }
    
    this.data.accounts.push(account);
    await this.save();
    
    console.log(`[本地数据库] 添加账号: ${account.email}`);
    return account;
  }
  
  // 批量添加账号
  async addAccounts(accountsData) {
    if (!this.config.enabled) return [];
    
    const added = [];
    for (const accountData of accountsData) {
      const account = await this.addAccount(accountData);
      if (account) {
        added.push(account);
      }
    }
    
    return added;
  }
  
  // 更新账号状态
  async updateAccountStatus(email, status, additionalData = {}) {
    if (!this.config.enabled) return null;
    
    const account = this.data.accounts.find(acc => acc.email === email);
    if (!account) {
      console.log(`[本地数据库] 账号不存在: ${email}`);
      return null;
    }
    
    // 更新状态
    account.status = status;
    account.updatedAt = new Date().toISOString();
    
    // 更新其他字段
    if (status === '出库' && additionalData.outboundPrice) {
      account.outboundDate = additionalData.outboundDate || new Date().toISOString().split('T')[0];
      account.outboundPrice = additionalData.outboundPrice;
      // 添加出库人信息
      if (additionalData.outboundUserId) {
        account.outboundUserId = additionalData.outboundUserId;
        account.outboundUserName = additionalData.outboundUserName;
      }
    }
    
    // 处理重新入库字段更新
    if (additionalData.reinboundPrice !== undefined) {
      account.reinboundDate = additionalData.reinboundDate || new Date().toISOString().split('T')[0];
      account.reinboundPrice = additionalData.reinboundPrice;
      if (additionalData.reinboundUserId) {
        account.reinboundUserId = additionalData.reinboundUserId;
        account.reinboundUserName = additionalData.reinboundUserName;
      }
    }
    
    Object.assign(account, additionalData);
    
    await this.save();
    console.log(`[本地数据库] 更新账号状态: ${email} -> ${status}`);
    
    return account;
  }
  
  // 获取所有账号
  getAllAccounts() {
    if (!this.config.enabled) return [];
    return this.data.accounts || [];
  }
  
  // 查询账号
  async findAccount(email) {
    if (!this.config.enabled) return null;
    
    return this.data.accounts.find(acc => acc.email === email);
  }
  
  // 按类型查询在库账号
  async queryByType(accountType) {
    if (!this.config.enabled) return [];
    
    return this.data.accounts.filter(acc => 
      acc.accountType === accountType && 
      acc.status === '在库' &&
      !acc.isBanned
    );
  }
  
  // 查询多个账号
  async findAccounts(filter = {}) {
    if (!this.config.enabled) return [];
    
    let results = [...this.data.accounts];
    
    // 应用过滤条件
    if (filter.status) {
      results = results.filter(acc => acc.status === filter.status);
    }
    
    if (filter.accountType) {
      results = results.filter(acc => acc.accountType === filter.accountType);
    }
    
    if (filter.submitterId) {
      results = results.filter(acc => acc.submitterId === filter.submitterId);
    }
    
    if (filter.limit) {
      results = results.slice(0, filter.limit);
    }
    
    return results;
  }
  
  // 获取统计信息
  async getStats() {
    if (!this.config.enabled) return {};
    
    const stats = {
      total: this.data.accounts.length,
      byStatus: {},
      byType: {},
      lastSync: this.data.metadata.lastSync
    };
    
    // 按状态统计
    this.data.accounts.forEach(acc => {
      stats.byStatus[acc.status] = (stats.byStatus[acc.status] || 0) + 1;
      stats.byType[acc.accountType] = (stats.byType[acc.accountType] || 0) + 1;
    });
    
    return stats;
  }
  
  // 获取综合统计信息（包含今日统计）
  async getStatistics() {
    if (!this.config.enabled) return {};
    
    // 获取总体统计
    const totalStats = await this.getStats();
    
    // 获取今日统计
    const todayStats = await this.getTodayStatistics();
    
    // 计算在库和出库数量
    const inStock = this.data.accounts.filter(acc => acc.status === '在库').length;
    const outStock = this.data.accounts.filter(acc => acc.status === '出库').length;
    
    return {
      total: totalStats.total,
      inStock: inStock,
      outStock: outStock,
      byType: totalStats.byType,
      todayTotal: todayStats.todayTotal,
      todayByType: todayStats.todayByType,
      todayBySubmitter: todayStats.todayBySubmitter,
      today: todayStats.today
    };
  }
  
  // 获取今日统计信息
  async getTodayStatistics() {
    if (!this.config.enabled) return {};
    
    const today = new Date().toISOString().split('T')[0];
    const todayAccounts = this.data.accounts.filter(acc => 
      acc.inboundDate === today
    );
    
    const stats = {
      today: today,
      todayTotal: todayAccounts.length,
      todayByType: {},
      todayBySubmitter: {}
    };
    
    // 按类型统计今日入库
    todayAccounts.forEach(acc => {
      stats.todayByType[acc.accountType] = (stats.todayByType[acc.accountType] || 0) + 1;
      if (acc.submitterName) {
        stats.todayBySubmitter[acc.submitterName] = (stats.todayBySubmitter[acc.submitterName] || 0) + 1;
      }
    });
    
    return stats;
  }
  
  // 备份数据库
  async backup() {
    if (!this.config.enabled || !this.config.backupEnabled) return;
    
    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backupDir = path.join(this.dbDir, 'backups');
      const backupPath = path.join(backupDir, `accounts-${timestamp}.json`);
      
      // 确保备份目录存在
      fs.mkdirSync(backupDir, { recursive: true });
      
      // 复制当前数据库文件
      const data = fs.readFileSync(this.dbPath, 'utf8');
      fs.writeFileSync(backupPath, data, 'utf8');
      
      console.log(`[本地数据库] 备份成功: ${backupPath}`);
      
      // 清理旧备份
      await this.cleanOldBackups(backupDir);
    } catch (error) {
      console.error('[本地数据库] 备份失败:', error);
    }
  }
  
  // 清理旧备份
  async cleanOldBackups(backupDir) {
    try {
      const files = fs.readdirSync(backupDir);
      const backupFiles = files
        .filter(f => f.startsWith('accounts-') && f.endsWith('.json'))
        .sort()
        .reverse();
      
      // 删除超过最大数量的备份
      if (backupFiles.length > this.config.maxBackups) {
        const toDelete = backupFiles.slice(this.config.maxBackups);
        for (const file of toDelete) {
          fs.unlinkSync(path.join(backupDir, file));
          console.log(`[本地数据库] 删除旧备份: ${file}`);
        }
      }
    } catch (error) {
      console.error('[本地数据库] 清理备份失败:', error);
    }
  }
  
  // 启动自动备份
  startAutoBackup() {
    if (this.config.backupInterval === 'daily') {
      // 每24小时备份一次
      setInterval(() => {
        this.backup();
      }, 24 * 60 * 60 * 1000);
      
      // 立即执行一次备份
      this.backup();
    }
  }
  
  // 导出为CSV
  async exportToCSV() {
    if (!this.config.enabled) return '';
    
    const headers = [
      'Email', 'Account Type', 'Status', 'Inbound Date', 'Inbound Price',
      'Auxiliary Email', 'Auxiliary Password', '2FA Code', 'Notes'
    ];
    
    const rows = this.data.accounts.map(acc => [
      acc.email,
      acc.accountType,
      acc.status,
      acc.inboundDate,
      acc.inboundPrice,
      acc.auxiliaryEmail,
      acc.auxiliaryPassword,
      acc.twoFACode,
      acc.notes.replace(/\n/g, ' ')
    ]);
    
    const csv = [
      headers.join(','),
      ...rows.map(row => row.map(cell => `"${cell || ''}"`).join(','))
    ].join('\n');
    
    return csv;
  }
  
  // 从Notion同步数据
  async syncFromNotion(notionData) {
    if (!this.config.enabled) return;
    
    console.log('[本地数据库] 开始从Notion同步数据...');
    
    // 这里可以实现与Notion的数据同步逻辑
    // 暂时留空，后续根据需要实现
    
    console.log('[本地数据库] 同步完成');
  }
}

module.exports = LocalDatabase;