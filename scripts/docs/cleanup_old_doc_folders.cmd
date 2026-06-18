@echo off
cd /d D:\thanh\project\manager
if exist prompts rmdir /s /q prompts
if exist business rmdir /s /q business
if exist security rmdir /s /q security
if exist checklists rmdir /s /q checklists
if exist adr rmdir /s /q adr
echo Cleanup done. Now copy the enterprise docs package into the project root.
