# 本地预览服务：和 python3 -m http.server 一样，只是告诉浏览器不要缓存，改了代码刷新就能看到。
# 用法：python3 tools/serve.py [端口=8770]（从哪里运行都行，服务的是项目根目录）
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

port = int(sys.argv[1]) if len(sys.argv) > 1 else 8770
ThreadingHTTPServer(('127.0.0.1', port), partial(Handler, directory=str(Path(__file__).resolve().parent.parent))).serve_forever()
