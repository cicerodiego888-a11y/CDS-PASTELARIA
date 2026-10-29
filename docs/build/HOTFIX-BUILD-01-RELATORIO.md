# HOTFIX-BUILD-01 — Desbloqueio seguro do build de entrega parcial

**Data:** 2026-10-26  
**Prioridade:** Urgente  
**Resultado:** BUILD OK (exit 0)

## 1. Causas raiz

| Falha | Causa | Correção |
|---|---|---|
| Smoke `compras.js` / `produtos.js` | Certificação MUC/RC4.31 e release carregavam `database.js` sem `DB_DIR` → barreira recusava fallback ProgramData | Isolamento com `isolarBancoTeste` / preload `-r` em pasta temporária; **sem** `CDS_ALLOW_OFFICIAL_DB` |
| Política import `ProdutoEmbalagemService` | `require('../../motores/muc/core/unidadesSi')` proibido | `isUnidadeConhecida` reexportada em `motores/muc/index.js`; serviço importa da fachada `muc` (não de `core/`) |
| Release certification no pipeline | Mesmo bloqueio de `DB_DIR` após MUC passar | Isolamento no `run.js` + preload no npm/build |

**Contrato MUC:** `public.js` permanece com a superfície congelada (não expandida). A reexportação em `index.js` evita import de `core/` pelos consumidores ERP, sem alterar o contrato DTO 1.0.0 de `public.js`.

## 2. Arquivos alterados

- `tests/muc/rc431-build-certificacao.test.js` — isolamento antes dos smoke requires
- `tests/e2e/release-certification/run.js` — isolamento antes de `database.js`
- `package.json` — `test:muc-rc431` e `test:release-certification` com preload
- `build/electron/build-erp-oficial.js` — preload nas etapas de certificação pós/pré-build
- `backend/motores/muc/index.js` — export `isUnidadeConhecida`
- `backend/services/produto-embalagem/ProdutoEmbalagemService.js` — import via fachada `muc`
- `docs/build/HOTFIX-BUILD-01-RELATORIO.md` — este relatório

## 3. Testes executados

| Comando | Resultado |
|---|---|
| `npm run test:muc-certificacao` | OK (contrato + RC1 + RC2 + RC431 + embalagens + SQL + integrity) |
| `npm run test:release-certification` | **APROVADA** 12/12 |
| `npm run build:erp` | **exit 0** — BUILD OK |

## 4. Artefato gerado

| Campo | Valor |
|---|---|
| Instalador | `C:\projetos\CDS-SISTEMAS PASTELARIA\dist\erp\CDS-ERP-Setup-1.0.3.exe` |
| Tamanho | 125 781 381 bytes (~120 MB) |
| SHA256 | `FA2F79A83007339B017A522B7493A23F2DE04AD91DEBEB048C12D7D136225B8D` |
| app.asar | `dist\erp\win-unpacked\resources\app.asar` (presente; integridade APROVADO no pipeline) |
| Versão | 1.0.3 |
| Manifest build | APROVADO (`8906239805addce6…`) |

## 5. Restrições respeitadas

- Banco oficial/cliente não acessado nem habilitado via `CDS_ALLOW_OFFICIAL_DB`.
- Certificações não removidas nem enfraquecidas.
- PDV / seletor empresarial / fluxo de vendas não alterados.
- Sem vendas, SEFAZ, migrações ou upgrade de dependências.

## 6. Encerramento

HOTFIX-BUILD-01 concluído. Instalador pronto para entrega parcial, com certificação MUC e release aprovadas no pipeline oficial.
