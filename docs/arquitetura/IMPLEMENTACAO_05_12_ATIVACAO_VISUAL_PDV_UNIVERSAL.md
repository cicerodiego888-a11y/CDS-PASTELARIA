# Sprint 05.12 — Ativação visual do PDV Universal

## Causa real

A rota `GET /pdv-universal` **já existia** (HTML + `verificarToken` + licença `pdv`) e a tela 05.01–05.10 estava completa.

O usuário não encontrava o PDV Universal porque **todo o acesso visual oficial apontava para `/pdv`**:

- ERP Comercial → “Abrir PDV” → `/pdv`
- Dashboard → `abrirModuloDashboard('pdv')` → `/pdv`
- Pós-login (caixa / módulo `pdv`) → `/pdv`
- Electron PDV (`CDS_APP_MODULO=pdv`) → login `?modulo=pdv` → `/pdv`

Não era rota ausente nem JS fora do static.

## Mapa de rotas

| Superfície | Destino |
| --- | --- |
| PDV legado | `GET /pdv` (inalterado) |
| PDV Universal | `GET /pdv-universal` |
| Menu ERP principal | `/pdv-universal` (item **PDV Universal**) |
| Menu ERP secundário | `/pdv` (**PDV legado**) |
| Menu do PDV legado | **PDV Universal** → `/pdv-universal` |
| Dashboard “PDV” | `/pdv-universal` |
| Login caixa / Electron PDV | continua `/pdv` (caixa, sangria, entregas do legado) |

## Electron

O ponto inicial do app PDV **não** foi trocado. O operador no Electron abre o legado e usa o item **PDV Universal** no menu, ou entra pelo ERP.

## Sem fallback

Erro de contexto permanece na tela Universal com **TENTAR NOVAMENTE**. Não redireciona para `/pdv`.
