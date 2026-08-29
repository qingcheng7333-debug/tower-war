@echo off
chcp 65001 >nul
title 嘗試ゲーム · 游戏服务器
echo === 嘗試ゲーム · 正在启动... ===
echo.
echo 游戏地址：http://localhost:8080
echo 关闭此窗口即可停止服务器
echo.
start http://localhost:8080
python -m http.server 8080 --directory "C:\Users\yuqing\astrbot\data\yuqingAI\未完成的ギャルゲ"
pause
