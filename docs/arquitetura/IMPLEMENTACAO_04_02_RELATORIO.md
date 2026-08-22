# Relatório — Sprint 04.02
## Configuração do modo de operação de venda

**Data:** 2026-08-21 · **Status:** concluída

### Decisão

A instalação passa a ter `modo_operacao_venda` persistido no **mesmo** `configuracoes.json` do `configuracaoService` (não há tabela nova).

Default e bootstrap: **EMPRESA_UNICA**.

`MULTIEMPRESA` pode ser persistido e é reconhecido na porta; **não** orquestra venda e **não** cai no fluxo legado.

Valor inválido persistido: erro explícito `MODO_OPERACAO_VENDA_INVALIDO` (não coage para MULTIEMPRESA nem finge EMPRESA_UNICA).

### Arquivos criados

- `backend/motores/muv/modoOperacaoVenda.js`
- `tests/muv/modo-operacao-venda-04-02.test.js`
- `docs/arquitetura/IMPLEMENTACAO_04_02_MODO_OPERACAO_VENDA.md`
- `docs/arquitetura/IMPLEMENTACAO_04_02_RELATORIO.md`

### Arquivos alterados

- `backend/motores/muv/contratos.js` — `MODOS_OPERACAO_VENDA`, `DEFAULT_MODO_OPERACAO_VENDA`, `validarModoOperacaoVenda`
- `backend/motores/muv/index.js` — reexporta a resolução
- `backend/services/configuracaoService.js` — DEFAULT, bootstrap, `obterModoOperacaoVenda`, save/validate
- `backend/services/vendas/VendaApplicationService.js` — ponto único de resolução na porta

### Comportamento EMPRESA_UNICA

PDV, Faturamento e NF avulsa continuam concluindo pelo `VendaPagamentoService`. Origens ainda não habilitadas continuam “reconhecida sem conclusão”.

### Comportamento MULTIEMPRESA

Modo resolvido; resposta `MODO_OPERACAO_VENDA_NAO_IMPLEMENTADO`; `venda_concluida: false`. Núcleo de pagamento **não** é chamado.

### Testes

`tests/muv/modo-operacao-venda-04-02.test.js` — **14/14 OK**

`tests/arquitetura/motor-universal-vendas-04-01.test.js` — **10/10 OK**

### Regressão

| Suite | Resultado |
|---|---|
| modo-operacao-venda-04-02 | 14/14 |
| motor-universal-vendas-04-01 | 10/10 |
| venda-application-service + venda-multi-origem-sprint22 | 15/15 |
| sprint31-faturamento (porta VAS) | 9/9 |
| muc-public-contract | 20/20 |
| porta-publica-saldos-multiempresa | 17/17 |
| reservas-dual-write-empresa | 12/12 |
| reservas-pdv-multiempresa-contexto | 10/10 |
| mts-multiempresa-contexto | 10/10 |
| pedido-expedicao-multiempresa-contexto | 12/12 |
| pedido-mts-disponibilidade-multiempresa | 5/5 |
| pedido-disponibilidade-multiempresa | 4/4 |
| configuracao_implantacao_test | OK |

### Limitações

- Sem UI administrativa (configuração técnica/backend).
- Sem tabela `atendimento` / `operacao_empresarial`.
- Sem checkout, pagamento dividido ou executor multiempresa.
- `GET` de configurações avançadas passa a incluir a chave no JSON (sem seletor visual).

### Próxima Sprint recomendada

**04.03** — implementar o esqueleto do executor MULTIEMPRESA (atendimento → N operações) sem pagamento dividido.

**04.03 não iniciada.**
