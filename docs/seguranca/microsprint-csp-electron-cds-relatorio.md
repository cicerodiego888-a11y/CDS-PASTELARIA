# Microsprint de segurança — CSP do Electron CDS

**Data:** 18/10/2026  
**Aviso alvo:** `Electron Security Warning (Insecure Content-Security-Policy)`  
**Escopo:** renderer principal (login / ERP / PDV / PDV Universal)

Não houve commit, push, merge, consulta SEFAZ nem acesso ao banco oficial nos testes.

---

## 1. Causa do aviso

Não existia **nenhuma** Content-Security-Policy no renderer (nem meta HTML, nem header HTTP, nem session Electron). No Electron 22, a ausência de CSP dispara o warning de CSP insegura (o mesmo warning também aparece se a política incluir `unsafe-eval`).

Auditoria adicional:

| Item | Resultado |
|---|---|
| Entry points | `package.json` → `electron.js`; builds ERP/PDV → `electron-erp.js` / `electron-pdv.js` → `electron-common.js` |
| `BrowserWindow` | `nodeIntegration: false`, `contextIsolation: true` (mantidos) |
| `unsafe-eval` / `eval` / `new Function` no app (JS não-minificado) | **Não encontrados** |
| Vendors (jquery/bootstrap/chart) | Sem `eval`/`new Function` detectáveis |
| Dependência real de `unsafe-eval` | **Nenhuma** comprovada |

---

## 2. Diretivas finais (canônicas)

Fonte única: `cds-csp-policy.js` → string `CSP_RENDERER`:

```
default-src 'self';
script-src 'self' 'unsafe-inline';
style-src 'self' 'unsafe-inline';
img-src 'self' data: blob:;
font-src 'self' data:;
connect-src 'self';
frame-src 'self' blob: data:;
worker-src 'self' blob:;
object-src 'none';
base-uri 'self';
form-action 'self';
frame-ancestors 'none'
```

### Por que ainda há `unsafe-inline`

| Diretiva | Motivo (não para silenciar aviso) |
|---|---|
| `script-src … 'unsafe-inline'` | Scripts de boot (`CDS_MODULE`) e handlers/`onclick`/HTML dinâmico legados do ERP/PDV |
| `style-src … 'unsafe-inline'` | Atributos `style=""` e estilos gerados em templates |

**Não** foi adicionado `unsafe-eval`.  
**Não** foram enfraquecidos `contextIsolation`, `sandbox` ou `nodeIntegration`.

### Dev vs empacotado

| Ambiente | Como a CSP chega |
|---|---|
| Dev (`npm start` / `electron.js`) | `aplicarCspElectron()` na `defaultSession` + header Express + meta HTML |
| ERP/PDV empacotado (`electron-common`) | Idem via `aplicarCspElectron()` no `whenReady` |
| Portal NFe (partition isolada) | Fora da `defaultSession` — CSP do site externo permanece |

---

## 3. Confirmação de bloqueio (não só “aviso sumiu”)

Runtime Electron (`scripts/verificar-csp-electron.js`):

```
eval bloqueado — Refused to evaluate … 'unsafe-eval' is not an allowed source …
new Function bloqueado — mesma recusa CSP
session default com CSP aplicada
PASS
```

Isso prova que a política **efetivamente impede** as permissões removidas (`unsafe-eval`), independentemente do warning sumir.

---

## 4. Arquivos alterados / criados

| Arquivo | Papel |
|---|---|
| `cds-csp-policy.js` | Política canônica + validação |
| `electron-csp.js` | Injeta CSP na `defaultSession` |
| `backend/middleware/cspHeaders.js` | Header HTTP Express |
| `backend/server.js` | Usa middleware CSP |
| `electron.js` / `electron-common.js` | `aplicarCspElectron()` no `whenReady` |
| `frontend/erp/index.html` | Meta CSP |
| `frontend/pdv/index.html` | Meta CSP |
| `frontend/shared/login.html` | Meta CSP |
| `frontend/pdv-universal/index.html` | Meta CSP |
| `tests/electron/csp-policy.test.js` | Testes estruturais + HTTP |
| `scripts/verificar-csp-electron.js` | Probe runtime eval/new Function |
| `docs/seguranca/microsprint-csp-electron-cds-relatorio.md` | Este relatório |

---

## 5. Testes executados (resultados reais)

```text
node --test tests/electron/csp-policy.test.js
→ 8/8 pass

.\node_modules\.bin\electron.cmd scripts\verificar-csp-electron.js
→ PASS (eval e new Function bloqueados)
```

---

## 6. Riscos residuais / próximos passos

1. Remover gradualmente `'unsafe-inline'` de `script-src` (extrair boots, eliminar `onclick` em templates).
2. Idem para `style-src` (migrar estilos inline para classes CSS).
3. Não reintroduzir `unsafe-eval` por dependência de bibliotecas — preferir build sem eval.

---

## 7. Decisão

| Critério | Status |
|---|---|
| Aviso causado por CSP ausente | Confirmado |
| CSP explícita aplicada | Sim |
| `unsafe-eval` removido/ausente | Sim |
| Bloqueio real de eval/new Function | Confirmado em runtime Electron |
| Isolamento Electron preservado | Sim |
| Pronto para declarar “só porque o aviso sumiu” | **Não** — bloqueio comprovado |
