# Relatório — Sprint 05.15

## STATUS

Conclusão visual da gestão fiscal por CNPJ. Sem novo motor, tabela ou storage.

## Implementado

- Lista: razão, fantasia, CNPJ, status cadastral, status fiscal oficial
- Nova empresa só com dados gerais; após POST abre a edição
- Edição com topo (empresa + CNPJ + status fiscal) e três abas explícitas
- Fiscal: ambiente, UF, série, numeração, CSC, `ws_autorizacao`
- Certificado: status ●/○, nome do arquivo, upload oficial
- Persistência da aba após salvar; prefixo `/api` único

## Não alterado

MUV, VAS, PDV legado, emissão NFC-e, EmpresaService de campos, schema fiscal.

## Testes

`tests/empresas/gestao-fiscal-visual-05-15.test.js`

## VALIDAÇÃO MANUAL PENDENTE

Nesta sessão o agente não executou clique autenticado no ERP (criar CNPJ, salvar CSC, upload .PFX). Recarregue Empresas após o deploy do JS e percorra o fluxo da seção 11 da sprint.
