import os
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page()
    page.on("console", lambda msg: print("CONSOLE:", msg.type, msg.text))
    page.on("pageerror", lambda err: print("PAGE ERROR:", err))
    page.goto(f"file://{os.path.abspath('app.html')}")
    page.wait_for_timeout(2000)
    print("BODY INNER HTML:\n", page.inner_html("body"))
    browser.close()
