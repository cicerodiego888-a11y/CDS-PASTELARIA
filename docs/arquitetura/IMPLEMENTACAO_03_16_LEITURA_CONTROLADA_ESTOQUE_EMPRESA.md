# Implementação 03.16 — leitura controlada de estoque_empresa

**Status:** concluída · **Data:** 2026-08-21  
**Projeto:** Pastelaria · Fase 2 Fundação Multiempresa

---

## Storage oficial

`produtos`. A porta pública (`estoqueSaldosPublico`) continua lendo `produtos`.

`estoque_empresa` permanece estrutura paralela.

---

## Método

`EstoqueEmpresaService.consultarSaldoParaEmpresa({ produtoId, empresaId, db })`

- `empresaId` explícito obrigatório → senão `EMPRESA_OBRIGATORIA`
- lê só `estoque_empresa`
- registro → `{ saldoFiscal, saldoNaoFiscal, estoqueAtual, reservadoFiscal, reservadoNaoFiscal }`
- inexistente → `null` (**não** significa usar legado)
- não cria, não copia `produtos`, não faz fallback, sem COMPAT, sem rota HTTP

Nenhum fluxo operacional usa esta leitura.
