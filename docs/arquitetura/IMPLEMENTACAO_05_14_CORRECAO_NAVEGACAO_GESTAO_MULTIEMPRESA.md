# Sprint 05.14 — Correção de navegação, sessão e gestão multiempresa

## Objetivo

Corrigir o acesso visual ao PDV Universal e reposicionar a gestão de empresas, sem criar motor, PDV, MUV, checkout ou cadastro paralelo.

## Auditoria do fluxo real

1. Menu ERP **PDV Universal** → `href="/pdv-universal/"`.
2. `express.static` entrega o HTML da pasta `frontend/pdv-universal` na URL com barra final (sem JWT no header do clique).
3. `GET /pdv-universal` (sem barra) continua autenticado por `verificarToken`. Sem token, HTML redireciona para `/login?next=…`.
4. Causa do “voltar ao ERP”: login via `redirectIfLoggedIn` + `obterDestinoPosLogin` ia para `/erp` porque `next` não era honrado.
5. APIs `/api/pdv-universal/*` usam o JWT oficial (`localStorage.token` → `Authorization: Bearer`).
6. `X-Empresa-Id` residual (`cds_empresa_id` inválido) fazia o GET contexto falhar com `EMPRESA_OPERACIONAL_INVALIDA` e derrubava a tela. O backend **não** foi relaxado (05.02). O frontend limpa o header e tenta o GET de novo.
7. `409 NENHUMA_EMPRESA_DISPONIVEL` permanece só para EMPRESA_UNICA sem empresas. Não foi removido para forçar a tela.
8. EMPRESA_UNICA com `exige_selecao` e MULTIEMPRESA com `empresa_selecionada = null` são **200**: tela READY.

## Autenticação

Mesma sessão do login oficial. Sem segundo token. `destinoNavegacaoSeguro` aceita apenas `/pdv-universal`, `/pdv` e `/erp`.

## Gestão de empresas

Item **Empresas** saiu do menu lateral Administração. Acesso: Configurações → Configurações Avançadas → EMPRESAS (`loadPage('empresas')` + `gestao-empresas-fiscal.js` da 05.11).

## Fora de escopo

MUV, `AtendimentoMultiempresaService`, fiscalização, `VendaApplicationService`, `POST /api/vendas`, `/pdv` legado.
