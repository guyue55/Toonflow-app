#!/usr/bin/env bash

# ==============================================================================
# Toonflow 服务启动脚本
# ==============================================================================

# 确保在脚本所在目录执行
cd "$(dirname "$0")"

# 颜色输出定义
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${GREEN}>>> 正在准备启动 Toonflow 服务...${NC}"

# 1. 检查是否存在构建产物，若不存在则先执行构建
if [ ! -f "data/serve/app.js" ]; then
    echo -e "${YELLOW}未检测到后端构建文件 (data/serve/app.js)，正在自动构建...${NC}"
    if command -v yarn >/dev/null 2>&1; then
        yarn build
    else
        npm run build
    fi
fi

# 2. 检查 PM2 命令可用性
PM2_CMD="pm2"
if ! command -v pm2 >/dev/null 2>&1; then
    PM2_CMD="npx pm2"
fi

# 3. 启动 PM2 服务
echo -e "${GREEN}>>> 启动 PM2 进程 (pm2.json)...${NC}"
$PM2_CMD start pm2.json

# 4. 保存当前 PM2 进程状态
$PM2_CMD save

echo -e "\n${GREEN}========================================${NC}"
echo -e "${GREEN} Toonflow 服务启动成功！${NC}"
echo -e "${GREEN} 服务地址: http://127.0.0.1:10588${NC}"
echo -e "${GREEN}========================================\n"

# 5. 展示当前进程状态
$PM2_CMD status toonflow-app
