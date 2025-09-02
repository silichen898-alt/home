// 服务器同步模块 - 本地数据自动同步到服务器
const fs = require('fs');
const http = require('http');

class ServerSync {
  constructor() {
    this.serverUrl = 'http://172.17.60.148:3001';
    this.dbPath = './local-db/accounts.json';
    this.lastSyncTime = 0;
    this.syncInterval = 30000; // 30秒同步一次
  }

  // 读取本地数据库
  readLocalDatabase() {
    try {
      const data = fs.readFileSync(this.dbPath, 'utf8');
      return JSON.parse(data);
    } catch (error) {
      console.error('读取本地数据库失败:', error);
      return null;
    }
  }

  // 同步数据到服务器
  async syncToServer() {
    try {
      const localData = this.readLocalDatabase();
      if (!localData) return false;

      const response = await this.postData('/api/sync', localData);
      
      if (response.success) {
        console.log(`✅ 同步成功: ${response.synced}条记录 - ${new Date().toLocaleString()}`);
        this.lastSyncTime = Date.now();
        return true;
      } else {
        console.error('❌ 同步失败:', response.error);
        return false;
      }
    } catch (error) {
      console.error('❌ 同步异常:', error.message);
      return false;
    }
  }

  // 发送HTTP POST请求
  postData(path, data) {
    return new Promise((resolve, reject) => {
      const postData = JSON.stringify(data);
      const options = {
        hostname: '172.17.60.148',
        port: 3001,
        path: path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData)
        }
      };

      const req = http.request(options, (res) => {
        let responseData = '';
        res.on('data', (chunk) => {
          responseData += chunk;
        });
        res.on('end', () => {
          try {
            resolve(JSON.parse(responseData));
          } catch (error) {
            reject(new Error('解析响应失败'));
          }
        });
      });

      req.on('error', (error) => {
        reject(error);
      });

      req.write(postData);
      req.end();
    });
  }

  // 启动定时同步
  startAutoSync() {
    console.log('🔄 启动自动同步到服务器...');
    
    // 立即同步一次
    this.syncToServer();
    
    // 定时同步
    setInterval(() => {
      this.syncToServer();
    }, this.syncInterval);
  }

  // 检查服务器连接
  async checkConnection() {
    try {
      const response = await this.getData('/api/health');
      return response.status === 'ok';
    } catch (error) {
      return false;
    }
  }

  // 发送HTTP GET请求
  getData(path) {
    return new Promise((resolve, reject) => {
      const options = {
        hostname: '172.17.60.148',
        port: 3001,
        path: path,
        method: 'GET'
      };

      const req = http.request(options, (res) => {
        let responseData = '';
        res.on('data', (chunk) => {
          responseData += chunk;
        });
        res.on('end', () => {
          try {
            resolve(JSON.parse(responseData));
          } catch (error) {
            reject(new Error('解析响应失败'));
          }
        });
      });

      req.on('error', (error) => {
        reject(error);
      });

      req.end();
    });
  }
}

module.exports = ServerSync;