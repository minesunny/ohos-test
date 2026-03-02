#!/usr/bin/env python3
import argparse
import xml.etree.ElementTree as ET
from pathlib import Path


def indent(elem, level=0):
    i = "\n" + level * "  "
    if len(elem):
        if not elem.text or not elem.text.strip():
            elem.text = i + "  "
        for child in elem:
            indent(child, level + 1)
            if not child.tail or not child.tail.strip():
                child.tail = i + "  "
        if not elem[-1].tail or not elem[-1].tail.strip():
            elem[-1].tail = i
    elif level and (not elem.tail or not elem.tail.strip()):
        elem.tail = i


def ensure_text_node(parent, tag):
    node = parent.find(tag)
    if node is None:
        node = ET.SubElement(parent, tag)
    return node


def find_or_create_usb_hdc_device(env_node):
    for device in env_node.findall("device"):
        if device.get("type") == "usb-hdc":
            return device
    device = ET.SubElement(env_node, "device", {"type": "usb-hdc", "label": "ohos"})
    ET.SubElement(device, "info", {"ip": "", "port": "", "sn": "", "alias": ""})
    return device


def main():
    parser = argparse.ArgumentParser(description="Update OpenHarmony user_config.xml")
    parser.add_argument("--config", required=True, help="Path of user_config.xml")
    parser.add_argument("--tests-dir", required=True, help="Directory of test cases")
    parser.add_argument("--ip", default="", help="Device IP")
    parser.add_argument("--port", default="8710", help="Device HDC port")
    parser.add_argument("--sn", default="", help="Device serial number")
    args = parser.parse_args()

    config_path = Path(args.config).expanduser().resolve()
    tests_dir = str(Path(args.tests_dir).expanduser().resolve())

    tree = ET.parse(config_path)
    root = tree.getroot()

    environment = root.find("environment")
    if environment is None:
        environment = ET.SubElement(root, "environment")

    device = find_or_create_usb_hdc_device(environment)
    info = device.find("info")
    if info is None:
        info = ET.SubElement(device, "info", {"ip": "", "port": "", "sn": "", "alias": ""})

    if args.ip:
        info.set("ip", args.ip)
    if args.port:
        info.set("port", args.port)
    if args.sn:
        info.set("sn", args.sn)

    test_cases = root.find("test_cases")
    if test_cases is None:
        test_cases = ET.SubElement(root, "test_cases")
    test_dir = ensure_text_node(test_cases, "dir")
    test_dir.text = tests_dir

    indent(root)
    tree.write(config_path, encoding="utf-8", xml_declaration=True)
    print(f"Updated {config_path}")


if __name__ == "__main__":
    main()
