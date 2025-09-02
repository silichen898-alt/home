// Git数据库同步模块 - 简化版
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

class GitSync {
  constructor() {
    this.dbPath = './local-db/accounts.json';
    this.isEnabled = true;
    this.lastSyncTime = 0;
  }

  // 自动提交数据库变化
  async commitDatabase(message = 'Auto sync database') {
    if (!this.isEnabled) return false;
    
    try {
      // 检查是否有变化
      const { stdout } = await this.execCommand('git status --porcelain local-db/accounts.json');
      if (!stdout.trim()) {
        console.log('[Git同步] 数据库无变化，跳过提交');
        return true;
      }
      
      // 提交变化
      await this.execCommand('git add local-db/accounts.json');
      await this.execCommand(`git commit -m "${message}"`);
      await this.execCommand('git push origin master');
      
      console.log(`✅ [Git同步] 数据库已同步到远程: ${new Date().toLocaleString()}`);
      this.lastSyncTime = Date.now();
      return true;
      
    } catch (error) {
      console.error('❌ [Git同步] 提交失败:', error.message);
      return false;
    }
  }

  // 从远程拉取最新数据
  async pullDatabase() {
    if (!this.isEnabled) return false;
    
    try {
      await this.execCommand('git pull origin master');
      console.log(`✅ [Git同步] 已拉取最新数据: ${new Date().toLocaleString()}`);
      return true;
      
    } catch (error) {
      console.error('❌ [Git同步] 拉取失败:', error.message);
      return false;
    }
  }

  // 执行Git命令
  execCommand(command) {
    return new Promise((resolve, reject) => {
      exec(command, (error, stdout, stderr) => {
        if (error) {
          reject(error);
        } else {
          resolve({ stdout, stderr });
        }
      });
    });
  }

  // 启动定期拉取（用于备用机器人）
  startPullSync(interval = 30000) {
    console.log('🔄 [Git同步] 启动定期拉取模式...');
    setInterval(() => {
      this.pullDatabase();
    }, interval);
  }

  // 启动推送模式（用于主力机器人）
  startPushSync() {
    console.log('🔄 [Git同步] 启动推送模式...');
    
    // 监听数据库文件变化
    const chokidar = require('chokidar');
    const watcher = chokidar.watch(this.dbPath, {
      ignoreInitial: true,
      persistent: true
    });

    watcher.on('change', () => {
      console.log('[Git同步] 检测到数据库变化，准备同步...');
      setTimeout(() => {
        this.commitDatabase('Auto sync: database updated');
      }, 2000); // 延迟2秒确保写入完成
    });
  }
}

module.exports = GitSync;