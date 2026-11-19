# MATRIZ DE TESTES EXISTENTES

Auditoria **não** criou testes. Apenas inventário.

| Cenário | Cobertura? | Evidência |
|---|---|---|
| Cadastro COMERCIAL / tipo operacional | Sim | `tests/pastelaria/separacao-produtos-insumos.test.js`, fundação 03.03 |
| Cadastro INSUMOS + comercializável | Sim | `tests/insumos/insumos-produto-comercializavel-01.test.js` |
| Pesquisa produtos Pedido | Sim | mesma suite + `tests/pedidos/pedido-busca-refrigerantes-insumos-02.test.js` |
| Seleção refrigerantes (INSUMO) | Sim | insumos-comercializavel + pedido-busca-refrigerantes |
| Lançamento pastéis / personalização UI | Parcial | `tests/mobile-pedido/mobile-pedido-02.test.js`; desktop menos unitário |
| Ficha técnica | Sim | `tests/pastelaria/fundacao-produtos-ficha-tecnica-03-03.test.js` |
| Personalização persistência | Parcial/Sim | fluxos em pedidos + snapshots na suite comercializável L |
| Persistência Pedido | Sim | várias em `tests/pedidos/*`, `pedido-operacional-*` |
| Exclusão de itens | Parcial | implícita em edição (repo DELETE); teste dedicado pouco aparente |
| Estoque / reserva / ficha | Sim | `pedido-consumo-estoque`, `consumo-ficha-tecnica-venda-03-04`, estornos 03.07/03.08, multiempresa |
| Conversão em venda | Sim | faturamento / ponte reserva / composições PDV |
| Cozinha despacho lê snapshots | Sim | `tests/cozinha/sprint02-*` |
| Classificação PASTEL/BEBIDA/OUTRO oficial | Não | inexistente no domínio; Cozinha S02 usa OUTRO default pós-correção |

## Lacunas relevantes para a Cozinha
- Sem teste de aceitação E2E “pastel + coca no mesmo atendimento → despacho” no pacote Cozinha.
- Sem campo/teste de classificação operacional de preparação (PASTEL/BEBIDA/OUTRO) no cadastro.
