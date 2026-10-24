# Microsprint P0.8.1 — Correção: botão de ativação fiscal real não encontrado

**Prioridade:** P0 — Usabilidade / ativação controlada  
**Data:** 18/10/2026  
**Dependência:** P0.8 ativação controlada · P0.9 auditoria  
**Decisão final:** **CORRIGIDO**

Sem consulta SEFAZ real, sem banco oficial, sem commit/push/merge. Operação fiscal real **não** é ativada automaticamente.

---

## 1. Causa raiz

Três fatores combinados:

1. **Localização oculta** — O botão “Habilitar operação real” existia apenas em  
   `Central → ⋮ → Configurações (Enterprise) → aba SEFAZ`,  
   enquanto a aba padrão ao abrir Configurações é **Ambiente**. O operador não via o painel sem trocar de aba.

2. **Mensagem ambígua** — O toast dizia “Configuração → SEFAZ”, fácil de confundir com o botão **“Abrir Configuração Fiscal”** (abre `configuracoes-avancadas`, outra tela, sem o painel DistDFe).

3. **Cache de assets** — `frontend/erp/js/app.js` usava `CDS_ERP_ASSET_VERSION = '0519'`. O browser podia servir `central-entradas.js` antigo **sem** o markup do painel P0.8.

Não havia bloqueio de renderização por perfil no frontend (o botão deveria aparecer para todos; só a API exige ADMIN). O problema era descoberta + cache + aba errada.

---

## 2. Correção

| Item | Mudança |
|---|---|
| Painel DistDFe | Card em destaque no **topo** da aba SEFAZ (`#centralCfgCardOperacaoReal`) |
| Atalho | Menu ⋮ → **Operação fiscal real (DistDFe)** |
| Deep-link | `abrirPainelOperacaoFiscalRealCentral()` abre Config → aba SEFAZ + scroll/destaque |
| Sync bloqueado | `confirm` oferece abrir o painel correto |
| Permissão UI | Não-admin: botões habilitar/desabilitar `disabled` + alerta textual |
| Cache | Versão ERP → `p081-op-real` |

Backend (confirmações, pré-voo, barreira) **inalterado em regras**; sem auto-habilitar.

---

## 3. Como o operador deve acessar agora

1. Recarregar a Central com **Ctrl+F5** (nova versão do script).  
2. Menu **⋮** → **Operação fiscal real (DistDFe)**  
   *ou* Configurações → aba **SEFAZ** (card amarelo no topo).  
3. Como ADMIN/SUPER_ADMIN: **Habilitar operação real** (confirmações).  
4. **Consultar DF-e (produção)** com confirmação explícita.

Não usar “Abrir Configuração Fiscal” para esta ativação.

---

## 4. Arquivos alterados

| Arquivo | Alteração |
|---|---|
| `frontend/erp/js/central-entradas.js` | Card no topo, atalho, deep-link, permissões UI, sync→painel |
| `frontend/erp/js/app.js` | Cache-bust `p081-op-real` |
| `tests/fiscal/microsprint-p0-8-1-botao-ativacao-fiscal-real.test.js` | **Novo** |
| `docs/fiscal/microsprint-p0-8-1-correcao-botao-ativacao-fiscal-real-relatorio.md` | Este relatório |

---

## 5. Testes executados

```bash
node --test tests/fiscal/microsprint-p0-8-1-botao-ativacao-fiscal-real.test.js
```

**Resultado real:** 7/7 pass (isolamento estático; sem SEFAZ; sem banco oficial).

---

## 6. Limitações

- Exige reload com cache-bust para quem ainda tem `?v=0519`.  
- Habilitação continua exigindo ADMIN no backend; UI só antecipa o bloqueio.  
- Primeira consulta real permanece ação explícita do operador (sem auto DistDFe).

---

## 7. Hotfix — SUPER_ADMIN bloqueado na UI (18/10/2026)

**Sintoma:** painel visível, pré-voo OK, mas aviso “perfil não tem permissão” e botões desabilitados para SUPER_ADMIN.

**Causa:** `obterUsuarioLogadoCentral()` lia `localStorage.usuario`, enquanto o login oficial grava em `localStorage.user` (`frontend/shared/js/login.js` / `access-control.js`). O perfil vinha vazio na Central.

**Correção:** ler `user` (+ fallback `usuario`), reutilizar `isSuperAdminUser` / `podeAjustarEstoque`, exibir perfil detectado no card. Cache-bust: `p081-op-real-perfil`.

**Ação do operador:** Ctrl+F5 e tentar **Habilitar operação real** novamente.
