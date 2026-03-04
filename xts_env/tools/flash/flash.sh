#!/bin/bash
# flash_device_retry.sh - 带重试机制的刷机脚本
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UPGRADE_TOOL="${UPGRADE_TOOL:-}"
if [ -z "${UPGRADE_TOOL}" ]; then
    if [ -x "${SCRIPT_DIR}/upgrade_tool_v2.17_for_linux/upgrade_tool" ]; then
        UPGRADE_TOOL="${SCRIPT_DIR}/upgrade_tool_v2.17_for_linux/upgrade_tool"
    elif [ -x "/opt/tools/flash/upgrade_tool_v2.17/upgrade_tool_v2.17_for_linux/upgrade_tool" ]; then
        UPGRADE_TOOL="/opt/tools/flash/upgrade_tool_v2.17/upgrade_tool_v2.17_for_linux/upgrade_tool"
    elif [ -x "$HOME/bin/upgrade_tool" ]; then
        UPGRADE_TOOL="$HOME/bin/upgrade_tool"
    fi
fi

if [ -z "${UPGRADE_TOOL}" ] || [ ! -x "${UPGRADE_TOOL}" ]; then
    echo "错误: 未找到可执行刷机工具 upgrade_tool"
    echo "请设置环境变量 UPGRADE_TOOL，或放置到以下路径之一："
    echo "  1) ${SCRIPT_DIR}/upgrade_tool_v2.17_for_linux/upgrade_tool"
    echo "  2) /opt/tools/flash/upgrade_tool_v2.17/upgrade_tool_v2.17_for_linux/upgrade_tool"
    echo "  3) $HOME/bin/upgrade_tool"
    exit 1
fi

run_with_priv() {
    if [ "$(id -u)" -eq 0 ]; then
        "$@"
    elif command -v sudo >/dev/null 2>&1; then
        sudo "$@"
    else
        "$@"
    fi
}

# 参数检查
if [ $# -ne 1 ]; then
    echo "用法: $0 <镜像目录>"
    echo "示例: $0 /home/ubuntu/openharmony/out/rk3568/packages/phone/images"
    exit 1
fi

IMAGE_DIR="$1"

# 检查目录
if [ ! -d "$IMAGE_DIR" ]; then
    echo "错误: 目录不存在 '$IMAGE_DIR'"
    exit 1
fi

# 检查必要文件是否存在
check_files() {
    local required_files=(
        "MiniLoaderAll.bin"
        "parameter.txt"
        "uboot.img"
        "resource.img"
    )
    
    for file in "${required_files[@]}"; do
        if [ ! -f "${IMAGE_DIR}/${file}" ]; then
            echo "错误: 缺少必要文件 '$file'"
            return 1
        fi
    done
    return 0
}

# 等待设备进入Loader模式
wait_for_loader() {
    echo "等待设备进入Loader模式..."
    local max_retries=60
    local retry_count=0
    
    while [ $retry_count -lt $max_retries ]; do
        if run_with_priv "${UPGRADE_TOOL}" ld 2>/dev/null | grep -q "Loader"; then
            echo "✅ 设备已进入Loader模式"
            return 0
        fi
        
        echo -n "."
        sleep 1
        retry_count=$((retry_count + 1))
    done
    
    echo ""
    echo "❌ 超时: 设备未进入Loader模式"
    return 1
}

# 重启设备到Loader模式
reboot_to_loader() {
    echo "尝试重启设备到Loader模式..."
    
    # 尝试使用hdc
    if command -v hdc &> /dev/null; then
        echo "使用hdc重启..."
        hdc shell reboot loader 2>/dev/null && return 0
    fi
    
    # 尝试使用adb
    if command -v adb &> /dev/null; then
        echo "使用adb重启..."
        adb reboot bootloader 2>/dev/null && return 0
    fi
    
    # 如果都无法重启，提示手动操作
    echo "请手动将设备重启到Loader模式:"
    echo "1. 设备关机"
    echo "2. 按住Volume+键（或Recovery键）"
    echo "3. 连接USB到电脑"
    echo "4. 保持按键直到出现Loader模式"
    
    read -p "按回车键继续..." _
    return 0
}

# 刷写镜像
flash_image() {
    local cmd="$1"
    local file="$2"
    local max_retries=3
    local retry_count=0
    
    while [ $retry_count -lt $max_retries ]; do
        echo "刷写 $file (尝试 $((retry_count + 1))/$max_retries)..."
        
        if run_with_priv "${UPGRADE_TOOL}" $cmd "${IMAGE_DIR}/${file}" 2>&1; then
            echo "✅ $file 刷写成功"
            return 0
        fi
        
        echo "⚠️  $file 刷写失败，等待重试..."
        sleep 2
        retry_count=$((retry_count + 1))
        
        # 检查设备是否还在
        if ! run_with_priv "${UPGRADE_TOOL}" ld 2>/dev/null | grep -q "Found"; then
            echo "设备连接丢失，尝试重新连接..."
            wait_for_loader || return 1
        fi
    done
    
    echo "❌ $file 刷写失败，已达到最大重试次数"
    return 1
}

# 主函数
main() {
    echo "🚀 刷机脚本 - 带重试机制"
    echo "镜像目录: $IMAGE_DIR"
    echo ""
    
    # 检查文件
    echo "🔍 检查镜像文件..."
    check_files || exit 1
    
    # 确保在Loader模式
    echo ""
    echo "1. 确保设备在Loader模式..."
    if ! run_with_priv "${UPGRADE_TOOL}" ld 2>/dev/null | grep -q "Loader"; then
        reboot_to_loader
        wait_for_loader || {
            echo "❌ 无法检测到Loader设备，请检查:"
            echo "  1. USB连接是否正常"
            echo "  2. 设备是否进入Loader模式"
            echo "  3. 运行: ${UPGRADE_TOOL} ld"
            exit 1
        }
    fi
    
    # # 刷写MiniLoader
    # echo ""
    # echo "2. 刷写MiniLoader..."
    # flash_image "db" "MiniLoaderAll.bin" || exit 1
    
    # 等待设备重新枚举
    echo "等待设备重新连接..."
    sleep 3
    wait_for_loader || {
        echo "❌ 设备重连失败"
        exit 1
    }
    
    # 刷写其他镜像
    echo ""
    echo "3. 刷写系统镜像..."
    
    # 定义刷写顺序
    declare -A flash_sequence=(
        [1]="parameter.txt:di -p"
        [2]="uboot.img:di -uboot"
        [3]="resource.img:di -resource"
        [4]="boot_linux.img:di -boot_linux"
        [5]="ramdisk.img:di -ramdisk"
        [6]="system.img:di -system"
        [7]="vendor.img:di -vendor"
        [8]="sys_prod.img:di -sys-prod"
        [9]="chip_prod.img:di -chip-prod"
        [10]="updater.img:di -updater"
        [11]="eng_system.img:di -eng_system"
        [12]="chip_ckm.img:di -chip_ckm"
        [13]="userdata.img:di -userdata"
    )
    
    for i in {1..13}; do
        entry="${flash_sequence[$i]}"
        if [ -n "$entry" ]; then
            filename="${entry%%:*}"
            cmd="${entry##*:}"
            
            if [ -f "${IMAGE_DIR}/${filename}" ]; then
                flash_image "$cmd" "$filename" || {
                    echo "❌ 关键文件刷写失败，停止刷机"
                    exit 1
                }
            else
                echo "⚠️  跳过不存在的文件: $filename"
            fi
        fi
    done
    
    # 重启设备
    echo ""
    echo "4. 重启设备..."
    if run_with_priv "${UPGRADE_TOOL}" rd 2>&1; then
        echo "🎉 刷机完成！设备正在重启..."
    else
        echo "⚠️  重启命令发送失败，请手动重启设备"
    fi
}

# 运行主函数
main
