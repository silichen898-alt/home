// 统一统计管理器 - KISS版本
// 合并所有统计逻辑，减少代码重复

class UnifiedStats {
  constructor(localDB) {
    this.db = localDB;
    this.today = new Date().toISOString().split('T')[0];
    
    // 用户别名映射
    this.userAliases = {
      '8154907183': 'silence',
      '8483048692': '有有'
    };
  }

  // 获取用户别名
  getUserAlias(userId) {
    return this.userAliases[userId?.toString()] || `用户${userId}`;
  }

  // 核心统计函数1：基础数量统计
  async getBasicStats() {
    const accounts = await this.db.getAllAccounts();
    
    return {
      total: accounts.length,
      inStock: accounts.filter(a => a.status === '在库').length,
      outStock: accounts.filter(a => a.status === '出库').length,
      banned: accounts.filter(a => a.status === '被封').length
    };
  }

  // 核心统计函数2：按类型统计
  async getTypeStats() {
    const accounts = await this.db.getAllAccounts();
    const inStockAccounts = accounts.filter(a => a.status === '在库');
    
    const typeStats = {};
    inStockAccounts.forEach(account => {
      const type = account.accountType || '未分类';
      typeStats[type] = (typeStats[type] || 0) + 1;
    });
    
    return typeStats;
  }

  // 核心统计函数3：操作人统计（合并今日入库、出库、重新入库）
  async getOperatorStats() {
    const accounts = await this.db.getAllAccounts();
    
    const stats = {
      today: this.today,
      inbound: this.getInboundStats(accounts),
      outbound: this.getOutboundStats(accounts), 
      reinbound: this.getReinboundStats(accounts)
    };

    return stats;
  }

  // 今日入库统计
  getInboundStats(accounts) {
    const todayInbound = accounts.filter(a => a.inboundDate === this.today);
    
    const submitterStats = {};
    let totalCount = 0;
    let totalAmount = 0;

    todayInbound.forEach(account => {
      const submitterId = account.submitterId || 'unknown';
      const submitterName = this.getUserAlias(submitterId);
      const accountType = account.accountType || '未分类';
      const price = account.inboundPrice || 0;

      if (!submitterStats[submitterId]) {
        submitterStats[submitterId] = {
          name: submitterName,
          total: 0,
          totalAmount: 0,
          byType: {}
        };
      }

      const stats = submitterStats[submitterId];
      stats.total++;
      stats.totalAmount += price;

      if (!stats.byType[accountType]) {
        stats.byType[accountType] = { count: 0, amount: 0 };
      }
      stats.byType[accountType].count++;
      stats.byType[accountType].amount += price;

      totalCount++;
      totalAmount += price;
    });

    return {
      submitters: submitterStats,
      totalCount,
      totalAmount,
      activeSubmitters: Object.keys(submitterStats).length
    };
  }

  // 出库统计
  getOutboundStats(accounts) {
    const outboundAccounts = accounts.filter(a => a.status === '出库');
    
    const userStats = {};
    let totalCount = 0;

    outboundAccounts.forEach(account => {
      const userId = account.outboundUserId || 'unknown';
      const userName = account.outboundUserName || this.getUserAlias(userId);
      const accountType = account.accountType || '未分类';

      if (!userStats[userId]) {
        userStats[userId] = {
          userName,
          count: 0,
          types: {}
        };
      }

      const stats = userStats[userId];
      stats.count++;
      stats.types[accountType] = (stats.types[accountType] || 0) + 1;
      totalCount++;
    });

    return {
      userStats,
      totalUsers: Object.keys(userStats).length,
      totalCount
    };
  }

  // 重新入库统计
  getReinboundStats(accounts) {
    const reinboundAccounts = accounts.filter(a => 
      a.reinboundDate && a.reinboundPrice !== null
    );
    
    const userStats = {};
    let totalCount = 0;
    let todayCount = 0;

    reinboundAccounts.forEach(account => {
      const userId = account.reinboundUserId || 'unknown';
      const userName = account.reinboundUserName || this.getUserAlias(userId);
      const reinboundDate = account.reinboundDate;
      const reinboundPrice = account.reinboundPrice || 0;

      if (!userStats[userId]) {
        userStats[userId] = {
          name: userName,
          count: 0,
          totalAmount: 0,
          todayCount: 0,
          todayAmount: 0
        };
      }

      const stats = userStats[userId];
      stats.count++;
      stats.totalAmount += reinboundPrice;
      totalCount++;

      if (reinboundDate === this.today) {
        stats.todayCount++;
        stats.todayAmount += reinboundPrice;
        todayCount++;
      }
    });

    return {
      userStats,
      totalUsers: Object.keys(userStats).length,
      totalCount,
      todayCount
    };
  }

  // 获取个人今日统计
  async getMyTodayStats(submitterId) {
    const accounts = await this.db.getAllAccounts();
    const myTodayAccounts = accounts.filter(a => 
      a.submitterId === submitterId && a.inboundDate === this.today
    );

    const byType = {};
    myTodayAccounts.forEach(account => {
      const type = account.accountType || '未分类';
      byType[type] = (byType[type] || 0) + 1;
    });

    return {
      total: myTodayAccounts.length,
      byType,
      today: this.today
    };
  }

  // 生成数据面板统计
  async getDashboardStats() {
    const [basicStats, typeStats, operatorStats] = await Promise.all([
      this.getBasicStats(),
      this.getTypeStats(),
      this.getOperatorStats()
    ]);

    return {
      basic: basicStats,
      types: typeStats,
      operators: operatorStats
    };
  }
}

module.exports = UnifiedStats;