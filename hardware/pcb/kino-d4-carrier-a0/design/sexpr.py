"""Small KiCad S-expression reader used by the reproducible carrier source."""
import json
import re
from pathlib import Path
import os,sys
_WIN=Path('C:/Program Files/KiCad/10.0/share/kicad')
_MAC=Path.home()/'Applications/KiCad/KiCad.app/Contents/SharedSupport'
_KS=_WIN if _WIN.exists() else _MAC if _MAC.exists() else Path('/Applications/KiCad/KiCad.app/Contents/SharedSupport')
STOCK_FP=_KS/'footprints'; STOCK_SYM=_KS/'symbols'   # stock KiCad libraries, Windows or macOS install

LIB = STOCK_SYM

def parse(text):
    tokens = re.findall(r'"(?:\\.|[^"\\])*"|[()]|[^\s()]+', text)
    stack, root = [], None
    for token in tokens:
        if token == '(':
            item = []
            if stack:
                stack[-1].append(item)
            else:
                root = item
            stack.append(item)
        elif token == ')':
            stack.pop()
        else:
            stack[-1].append(json.loads(token) if token.startswith('"') else token)
    return root

def children(node, name):
    return [x for x in node if isinstance(x, list) and x and x[0] == name]

def child(node, name, default=None):
    return next(iter(children(node, name)), default)

cache = {}
def symbol(lib_id):
    lib, name = lib_id.split(':', 1)
    if lib not in cache:
        cache[lib] = {s[1]: s for s in children(parse((LIB / (lib + '.kicad_sym')).read_text(encoding='utf-8')), 'symbol')}
    raw = cache[lib][name]
    parent = child(raw, 'extends')
    if parent:
        inherited = symbol(lib + ':' + parent[1])
        overridden = {x[1] for x in children(raw, 'property')}
        raw = raw + [x for x in inherited[2:] if isinstance(x, list) and (x[0] == 'symbol' or (x[0] == 'property' and x[1] not in overridden))]
    return raw

def pins(raw):
    result = {}
    for sub in children(raw, 'symbol'):
        for p in children(sub, 'pin'):
            result[child(p, 'number')[1]] = {'name': child(p, 'name')[1], 'type': p[1]}
    return result

def prop(raw, name):
    return next((x[2] for x in children(raw, 'property') if x[1] == name), '')

if __name__ == '__main__':
    import sys
    for lib_id in sys.argv[1:]:
        try:
            raw = symbol(lib_id)
            print(json.dumps({'id': lib_id, 'footprint': prop(raw, 'Footprint'), 'pins': pins(raw)}))
        except Exception as e:
            print(lib_id, str(e))
