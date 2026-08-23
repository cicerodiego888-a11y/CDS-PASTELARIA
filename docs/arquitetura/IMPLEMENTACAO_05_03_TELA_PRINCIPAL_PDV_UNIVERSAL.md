# Implementação 05.03 — Tela principal do PDV Universal

**Status:** concluída · **Sem carrinho funcional** · **Sem checkout**

## Abertura

`GET /pdv-universal` (token + módulo `pdv` licenciado) serve `frontend/pdv-universal/index.html`.

O PDV legado permanece em `GET /pdv`.

## Contexto

Ao abrir, a tela chama `GET /api/pdv-universal/contexto`.

Estados: LOADING / ERROR (`TENTAR NOVAMENTE`) / READY.

Modo e empresa vêm só da resposta. Sem `modo_operacao_venda` local e sem empresa 1.

## EMPRESA_UNICA

Empresa resolvida → nome no cabeçalho.  
`exige_selecao` → botão SELECIONAR EMPRESA.

## MULTIEMPRESA

`empresa_selecionada` pode ser null. Painel “EMPRESAS NO ATENDIMENTO” via capability `permite_multiplas_empresas_no_atendimento`. Sem atendimento.

## Seleção

Modal lista `empresas_disponiveis`. `PUT /api/pdv-universal/contexto/empresa` e novo GET.

## Capabilities

`aplicarCapabilities(contexto)` é o único ponto. A UI não espalha `if (modo === 'MULTIEMPRESA')`.

## Fora desta sprint

Carrinho, busca real, checkout, MUV, TEF, fiscal, impressão. Atalhos são só legenda. FINALIZAR desabilitado.
