import os
import glob
from playwright.sync_api import sync_playwright

def run_cuj(page):
    app_url = "http://localhost:8080/app.html"
    page.goto(app_url)
    page.wait_for_timeout(1000)

    # 1. Search Chess.com user 'Hikaru'
    input_elem = page.locator(".gb-search-input")
    input_elem.wait_for(state="visible", timeout=5000)
    input_elem.fill("Hikaru")
    page.wait_for_timeout(500)

    page.locator(".gb-search-btn").click()

    # Wait for game cards to load
    page.locator(".gb-card").first.wait_for(state="visible", timeout=15000)
    page.wait_for_timeout(1000)

    # 2. Filter by Blitz
    page.get_by_role("button", name="Blitz").click()
    page.wait_for_timeout(1500)

    # 3. Take screenshot of loaded games in mobile browser
    page.screenshot(path="/home/jules/verification/screenshots/verification.png")
    page.wait_for_timeout(1000)

if __name__ == "__main__":
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(
            viewport={"width": 390, "height": 844},
            user_agent="Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1",
            record_video_dir="/home/jules/verification/videos"
        )
        page = context.new_page()
        try:
            run_cuj(page)
        finally:
            context.close()
            browser.close()

    videos = glob.glob("/home/jules/verification/videos/*.webm")
    print("Recorded video:", videos)
