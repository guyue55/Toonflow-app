#!/usr/bin/env bash

# ==============================================================================
# Toonflow 服务停止脚本
# ==============================================================================

# 确保在脚本所在目录执行
cd "$(dirname "$0")"

# 颜色输出定义
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${YELLOW}>>> 正在停止 Toonflow 服务...${NC}"

# 检查 PM2 命令可用性
PM2_CMD="pm2"
if ! command -v pm2 >/dev/null 2>&1; then
    PM2_CMD="npx pm2"
fi

# 停止服务
$PM2_CMD stop pm2.json

# 保存停止状态
$PM2_CMD save

echo -e "\n${RED}========================================${NC}"
echo -e "${RED} Toonflow 服务已停止！${NC}"
echo -e "${RED}========================================\n"

# 展示当前进程状态
$PM2_CMD status toonflow-app
