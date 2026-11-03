import json, re, os, pathlib

SRC = pathlib.Path("~/.config/AmneziaVPN.ORG/AmneziaVPN.conf").expanduser()
raw = SRC.read_text()

m = re.search(r'^serversList=(.*)$', raw, re.M)
if not m:
    raise SystemExit("serversList не найден в файле")
val = m.group(1).strip()

# внешние кавычки INI и обёртка @ByteArray(...)
if val.startswith('"') and val.endswith('"'):
    val = val[1:-1]
if val.startswith('@ByteArray(') and val.endswith(')'):
    val = val[len('@ByteArray('):-1]

def unescape(s):
    out, i = [], 0
    while i < len(s):
        c = s[i]
        if c == '\\' and i + 1 < len(s):
            n = s[i + 1]
            if n in '"\\':
                out.append(n); i += 2
            elif n == 'n':
                out.append('\n'); i += 2
            elif n == 't':
                out.append('\t'); i += 2
            elif n == 'x':
                j = i + 2
                while j < len(s) and j < i + 6 and s[j] in '0123456789abcdefABCDEF':
                    j += 1
                out.append(chr(int(s[i+2:j], 16))); i = j
            else:
                out.append(n); i += 2
        else:
            out.append(c); i += 1
    return ''.join(out)

servers = json.loads(unescape(val))

# сохранить как есть, только для владельца
out = pathlib.Path("servers.json")
out.write_text(json.dumps(servers, indent=2, ensure_ascii=False))
os.chmod(out, 0o600)
print("записано:", out, "| серверов:", len(servers))

# структура без значений
def shape(x, depth=0, maxdepth=4):
    pad = "  " * depth
    if isinstance(x, dict):
        for k, v in x.items():
            if isinstance(v, (dict, list)) and depth < maxdepth:
                print(f"{pad}{k}: {type(v).__name__}")
