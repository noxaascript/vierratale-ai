import json
import http.client
import urllib.request
import urllib.error
from typing import Optional, Any


def http_get(url: str, headers: Optional[dict] = None, timeout: int = 30) -> Any:
    req = urllib.request.Request(url)
    if headers:
        for k, v in headers.items():
            req.add_header(k, v)
    resp = urllib.request.urlopen(req, timeout=timeout)
    return json.loads(resp.read())


def http_post(
    url: str,
    data: dict,
    headers: Optional[dict] = None,
    timeout: int = 30,
) -> Any:
    body = json.dumps(data).encode()
    default_headers = {"Content-Type": "application/json"}
    if headers:
        default_headers.update(headers)
    req = urllib.request.Request(url, data=body, headers=default_headers)
    resp = urllib.request.urlopen(req, timeout=timeout)
    return json.loads(resp.read())


def http_post_raw(
    url: str,
    data: bytes,
    headers: Optional[dict] = None,
    timeout: int = 30,
) -> http.client.HTTPResponse:
    default_headers = {"Content-Type": "application/json"}
    if headers:
        default_headers.update(headers)
    req = urllib.request.Request(url, data=data, headers=default_headers)
    return urllib.request.urlopen(req, timeout=timeout)
