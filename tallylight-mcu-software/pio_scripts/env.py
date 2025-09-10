import os

Import("env")

try:
    from dotenv import load_dotenv
except ImportError:
    # check if we are under archlinux
    if os.path.exists('/usr/bin/pacman'):
        print("Please install python-dotenv via 'sudo pacman -S python-dotenv'")
        exit(1)
    print("Installing python-dotenv via pip...")
    env.Execute("$PYTHONEXE -m pip install python-dotenv")

load_dotenv('secrets.env')

env.Replace(OTA_PASSWORD=os.getenv('OTA_PASSWORD'))