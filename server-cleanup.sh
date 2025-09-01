#!/bin/bash
# 阿里云服务器清理脚本 - 在服务器上运行

echo "🧹 开始清理阿里云服务器..."
echo "==================================================================================="

# 1. 停止所有机器人进程
echo "1. 停止所有机器人进程..."
pkill -f "node.*bot" 2>/dev/null || echo "没有找到运行中的机器人进程"
pkill -f "advanced-bot" 2>/dev/null || echo "没有找到advanced-bot进程"
pkill -f "server.js" 2>/dev/null || echo "没有找到server.js进程"
sleep 3

# 2. 备份重要数据（如果存在）
echo "2. 备份重要数据..."
if [ -d "/root/ai-bot-production" ]; then
    if [ -f "/root/ai-bot-production/local-db/accounts.json" ]; then
        cp /root/ai-bot-production/local-db/accounts.json /root/old-accounts-backup-$(date +%Y%m%d_%H%M%S).json
        echo "✅ 已备份accounts.json"
    fi
fi

# 3. 删除所有旧机器人文件
echo "3. 删除旧机器人文件..."
rm -rf /root/ai-bot-* 2>/dev/null || echo "没有ai-bot相关目录"
rm -rf /root/telegram-* 2>/dev/null || echo "没有telegram相关目录"
rm -rf /root/bot-* 2>/dev/null || echo "没有bot相关目录"
rm -rf /root/机器人* 2>/dev/null || echo "没有机器人目录"

# 4. 清理Node.js相关
echo "4. 清理Node.js相关..."
rm -rf /root/node_modules 2>/dev/null || echo "没有根目录node_modules"
rm -f /root/package*.json 2>/dev/null || echo "没有根目录package文件"

# 5. 安装必要软件
echo "5. 检查并安装必要软件..."
if ! command -v node &> /dev/null; then
    echo "安装Node.js..."
    curl -fsSL https://deb.nodesource.com/setup_18.x | bash -
    apt-get install -y nodejs
fi

if ! command -v git &> /dev/null; then
    echo "安装Git..."
    apt-get update && apt-get install -y git
fi

# 6. 创建部署目录
echo "6. 创建部署目录..."
mkdir -p /root/ai-bot-production-v2.1
cd /root/ai-bot-production-v2.1

echo "✅ 服务器清理完成！"
echo "==================================================================================="
echo "下一步：运行 GitHub 部署命令"
echo "git clone git@github.com:silichen898-alt/home.git ."
echo "或者使用HTTPS: git clone https://github.com/silichen898-alt/home.git ."
echo "==================================================================================="