@echo off
rem 本地离线转写服务(FunASR CPU)——首次启动需下载模型约 1.5GB,之后秒起
cd /d %~dp0
.venv\Scripts\python.exe server.py
