#!/bin/bash
# 阿里云服务器部署脚本 - 在服务器上运行

echo "🚀 开始部署机器人到阿里云服务器..."
echo "==================================================================================="

# 1. 从GitHub克隆最新代码
echo "1. 从GitHub克隆代码..."
cd /root
rm -rf ai-bot-production-v2.1
git clone https://github.com/silichen898-alt/home.git ai-bot-production-v2.1
cd ai-bot-production-v2.1

# 2. 安装依赖
echo "2. 安装Node.js依赖..."
npm install --only=production

# 3. 创建生产环境配置
echo "3. 创建生产环境配置..."
if [ ! -f "config.json" ]; then
    echo "⚠️  请从config.template.json创建config.json并填入正确的配置"
    echo "cp config.template.json config.json"
    echo "然后编辑config.json填入正确的botToken和adminIds"
fi

# 4. 创建必要目录
echo "4. 创建必要目录..."
mkdir -p local-db
mkdir -p json-input

# 5. 设置权限
echo "5. 设置文件权限..."
chmod +x start-bot.sh 2>/dev/null || echo "start-bot.sh不存在"

echo "✅ 部署完成！"
echo "==================================================================================="
echo "下一步操作："
echo "1. 编辑配置文件: nano config.json"
echo "2. 启动机器人: node advanced-bot.js"
echo "==================================================================================="