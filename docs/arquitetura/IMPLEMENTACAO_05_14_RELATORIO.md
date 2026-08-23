# Relatório — Sprint 05.14

## STATUS

Navegação/sessão do PDV Universal e posição da gestão de empresas. Sem novo motor.

## Causa real do “PDV Universal não abre”

Clique em `/pdv-universal` (sem barra) passava por `verificarToken` sem `Authorization`. Redirect para `/login` sem `next` + token ainda no `localStorage` devolvia o operador ao `/erp`. Contexto com `cds_empresa_id` inválido gerava erro geral da tela.

## Alterado

- `backend/middleware/auth.js` — HTML → `/login?next=`; API 401/403 com `SESSAO_INVALIDA`
- `frontend/shared/js/pdv-acesso-oficial.js` — URL oficial `/pdv-universal/`; `destinoNavegacaoSeguro`
- `frontend/shared/js/access-control.js` + `login.html` — honra `?next=`
- `frontend/erp/index.html` / `frontend/pdv/index.html` — href com barra; Empresas fora do lateral
- `frontend/pdv-universal/pdv-universal.js` + `index.html` — erros 401/403/409, retry, seleção, READY sem empresa
- `frontend/erp/js/cds-centro-configuracoes.js` + breadcrumb da gestão 05.11
- testes 05.11 / 05.12 / 05.13 ajustados ao menu e à URL oficial

## Não alterado

Contratos MUV, `POST /api/vendas`, `/pdv` legado, motores fiscais, `EmpresaService` de campos.

## Testes

`tests/pdv-universal/correcao-navegacao-e-gestao-multiempresa-05-14.test.js`

Também: 05.01, 05.02, 05.11, 05.12, 05.13 e principais do PDV Universal.

## VALIDAÇÃO MANUAL PENDENTE

Não há browser/Electron autenticado nesta sessão para clicar Login → ERP → PDV Universal → Configurações Avançadas → Empresas.

Checklist não executado no agente: login, clique real no menu, carrinho, FINALIZAR, salvar fiscal, upload de certificado, troca de empresa na UI.
