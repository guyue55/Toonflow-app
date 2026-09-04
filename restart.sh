#!/usr/bin/env bash

# ==============================================================================
# Toonflow 服务重启脚本 (支持自动编译并重新加载)
# ==============================================================================

# 确保在脚本所在目录执行
cd "$(dirname "$0")"

# 遇到错误立即中断
set -e

# 颜色输出定义
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${GREEN}>>> [1/3] 正在重新编译构建后端服务...${NC}"

# 1. 编译构建
if [ "$1" == "--no-build" ]; then
    echo -e "${YELLOW}检测到 --no-build 参数，跳过构建步骤。${NC}"
else
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

echo -e "\n${GREEN}>>> [2/3] 正在重启 PM2 进程...${NC}"

# 3. 重启服务（若尚未启动则自动启动）
$PM2_CMD restart pm2.json || $PM2_CMD start pm2.json

# 4. 保存当前状态
echo -e "\n${GREEN}>>> [3/3] 正在保存 PM2 进程状态...${NC}"
$PM2_CMD save

echo -e "\n${GREEN}========================================${NC}"
echo -e "${GREEN} Toonflow 服务重启并生效完成！${NC}"
echo -e "${GREEN} 服务地址: http://127.0.0.1:10588${NC}"
echo -e "${GREEN}========================================\n"

# 5. 展示当前进程状态
$PM2_CMD status toonflow-app
