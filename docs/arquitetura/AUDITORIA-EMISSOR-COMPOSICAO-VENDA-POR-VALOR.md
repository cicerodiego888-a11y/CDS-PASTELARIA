# Auditoria do emissor completo na Venda por Valor

**ID:** CDS-FISCAL-AUDIT-EMISSOR-COMPOSICAO-01  
**Base:** `docs/arquitetura/CORRECAO-DISTRIBUICAO-FISCAL-VENDA-POR-VALOR.md` e `docs/arquitetura/VALIDACAO-FISCAL-COMPOSICAO-VENDA-POR-VALOR.md`  
**Ambiente dos testes:** `emitirPorVendaId` real, venda em SQLite `:memory:`, `DB_DIR` temporário criado antes do `require`. Sem banco oficial, sem certificado, sem TEF, sem PIX real e sem transmissão à SEFAZ.  
**Produção:** nenhum arquivo de composição, fechamento, dinheiro ou emissor foi alterado.

## Classificação por pergunta

| Pergunta | Classificação |
|---|---|
| Itens saem de `vendas_itens.valor_fiscal`, com cadastro só para nome e tributos | CONFIRMADO e TESTADO EM AMBIENTE ISOLADO |
| O comercial do pedido e `produtos.preco_venda` não viram valor fiscal | TESTADO EM AMBIENTE ISOLADO |
| O emissor não chama a composição nem redistribui a venda por valor | CONFIRMADO |
| `itensFiscaisInteirosParaReferencia` só roda com a reescrita autorizada | CONFIRMADO e TESTADO EM AMBIENTE ISOLADO |
| `RECOMPOSICAO_HABILITADA_EM_PRODUCAO` permanece falso | TESTADO EM AMBIENTE ISOLADO |
| Com a flag falsa, o emissor não substitui os itens já gravados | TESTADO EM AMBIENTE ISOLADO |
| O desconto técnico entra uma vez, a partir de `vendas.desconto` | TESTADO EM AMBIENTE ISOLADO |
| O total fiscal é a soma de `valor_fiscal` menos esse desconto | TESTADO EM AMBIENTE ISOLADO |
| Emissão inicial monta XML; nota já autorizada devolve o DANFE gravado | TESTADO EM AMBIENTE ISOLADO |
| Repetição com `naoTransmitir` não grava segunda nota | TESTADO EM AMBIENTE ISOLADO |
| Nota autorizada impede novo documento | TESTADO EM AMBIENTE ISOLADO |
| Dinheiro confirmado não monta NFC-e | TESTADO EM AMBIENTE ISOLADO |
| Venda mista continua sem NFC-e | TESTADO EM AMBIENTE ISOLADO |
| Assinatura, transporte e gravação do XML autorizado | BLOQUEADO |
| Falha de persistência do XML e falha entre preparação e gravação | NÃO REPRODUZIDO |

Não há homologação SEFAZ e não há emissão de produção.

## 1. Auditoria estática

Função: `emitirPorVendaId` em `backend/services/fiscal/emissor.js`, linha 273.

1. `carregarVenda` (linha 93) lê `vendas`, `vendas_itens` com `INNER JOIN produtos`, `venda_recebimentos` com `status = 'aprovado'` e, se não houver recebimento, `venda_pagamentos`. Não há `pedidos_itens`, `prepararComposicaoPedidoPdv` nem `distribuirValorFiscalVendaPorValor`.
2. Os campos usados no documento são `quantidade_fiscal` e `valor_fiscal` (`itemEntraNaNfce`, linha 40, e `totalConferenciaEmissao`, linha 31). `produtos.preco_venda` é selecionado na linha 120 e não entra no total.
3. `selecionarItensFiscaisParaNfce` (linha 45) compara a soma de `valor_fiscal` com a referência fiscal dos pagamentos. Na mistura, se a diferença passar de R$ 0,02, devolve `DISTRIBUICAO_NAO_AUTORIZADA`.
4. A troca de itens está nas linhas 298–341, dentro de `reescritaDeComposicaoNoEmissorAutorizada()`. Com a flag falsa, `itensFiscaisInteirosParaReferencia` não é chamado. O desconto gravado não é substituído.
5. Se já existe `nfce_notas` com `status = 'autorizada'` para a venda (linhas 363–387), a função devolve essa nota e não monta outro XML.
6. Com `opcoes.naoTransmitir === true` (linhas 411–434), monta o XML por `buildNfceXml` e retorna antes do certificado, da assinatura e de `salvarNota`.
7. O caminho completo, a partir da linha 436, exige certificado apto, assina, gera QR Code, chama `enviarAutorizacao` e só então grava a nota (linha 798).
8. `salvarNota` (linha 190) grava no `db` importado pelo módulo, não em `opcoes.db`. Em produção os dois são o mesmo banco. Uma nota existente com a mesma chave, ou com a mesma venda, número, série e ambiente, é atualizada (linhas 214–241). Não nasce uma segunda linha.
9. Número pendente anterior é reaproveitado (linhas 453–455). Duplicidade SEFAZ `cStat 539` marca `rejeitada_duplicidade` (linha 772) e não cria outro item de venda.
10. Falha de validação do XML grava `erro_validacao` com o XML ainda sem assinatura (linhas 561–579). Configuração ou certificado ausente grava `configuracao_pendente` (linhas 461–498). Se `salvarNota` lançar erro, a função rejeita e o XML fica só em memória.
11. `obterDanfeHtmlAtualizado` (linha 838) relê os itens atuais e regrava o HTML no `db` do módulo. A reutilização de nota autorizada não passa por essa função.

A regra de 20% não é chamada pelo emissor. `calcularMargemToleranciaDinheiro` continua em `RecomposicaoFiscalToleranciaDinheiroSimulacaoService.js`. Para R$ 61,98, `Math.round(6198 * 0,2) = 1240`, margem R$ 12,40, `nao_e_desconto` verdadeiro. O percentual permanece 0,2.

## 2. Testes isolados

Arquivo: `tests/vendas/auditoria-emissor-composicao-venda-por-valor.test.js`.  
Comando: `node --test --test-concurrency=1`. Resultado: 6 testes, 6 aprovações.

O emissor não foi substituído por mock. A venda ficou em memória. As credenciais vieram do parâmetro já existente `getFiscalConfig`, com CSC artificial e sem caminho de certificado, para o ramo `naoTransmitir`. O `require` do emissor abre `database.js`; o `DB_DIR` já apontava para um diretório temporário (`cds-audit-emissor-valor-*`). Esse banco temporário não é o banco oficial.

O produto #747 foi gravado com `preco_venda` R$ 30,99 de propósito. O XML usou o `valor_fiscal` persistido.

| Cenário | Resultado medido |
|---|---|
| Venda 68, PIX R$ 61,98, itens 17,98 / 25,98 / 19,80, desconto 1,78 | `MODELO_BRUTO`, vProd 63,76, vDesc 1,78, vNF 61,98, vUnCom do pastel 8,99. Sem vUnCom 30,99 e sem vProd 61,98 no item |
| Segunda chamada da mesma venda | mesmos totais e zero linhas em `nfce_notas` |
| Nota `autorizada` já gravada | `reused: true`, DANFE persistido, sem XML novo, uma nota |
| Composição normal, pastel fiscal 43,98 e desconto 27,78 | vUnCom 21,99, vProd 89,76, vDesc 27,78, vNF 61,98 |
| Combinação exata, desconto 0 | `MODELO_LIQUIDO`, vProd 30,97, vDesc 0, vNF 30,97 |
| Dinheiro confirmado, `valor_fiscal` 0 | `sem_itens_fiscais`, sem XML |
| PIX 30 + dinheiro 31,98 | `recomposicao_bloqueada`, código `DISTRIBUICAO_NAO_AUTORIZADA`, desconto permanece 1,78, nenhuma nota |

`RECOMPOSICAO_HABILITADA_EM_PRODUCAO` e `reescritaDeComposicaoNoEmissorAutorizada()` permaneceram falsos durante os testes.

## 3. Emissão local

A emissão local desta auditoria é o XML sem assinatura devolvido por `naoTransmitir`. Ela confirma os valores do pedido #68 no emissor real. Não grava `nfce_notas`, não assina e não consulta a SEFAZ.

## 4. Homologação fiscal

Pendente. NCM, CFOP e CSOSN do teste são cadastro artificial para o montador não recusar o item. Não houve certificado, QR Code, lote, autorização nem ambiente de homologação da SEFAZ.

## 5. Produção

Não executada. A flag de recomposição permanece falsa. O banco oficial não foi aberto para esta auditoria.

## Persistência e falha

A leitura da venda, a recuperação da nota autorizada e a ausência de segunda nota no ramo sem transmissão foram testadas. A gravação do XML autorizado, a falha dessa gravação e a falha entre o XML pronto e o `INSERT` ficam no caminho que assina e transmite. Esse caminho não foi executado. Pela leitura do código, a nota é uma por venda, número, série e ambiente: a repetição atualiza a linha existente. Uma exceção de `salvarNota` não cria documento parcial dentro da função; a promessa rejeita.

## Plano de correção

Nenhuma correção do emissor é indicada para a distribuição da venda por valor. Os R$ 17,98 e o desconto de R$ 1,78 chegam ao XML a partir do que já está em `vendas_itens` e `vendas.desconto`. O comercial R$ 61,98 não é restaurado. O desconto não é recalculado nem duplicado. A mistura e o dinheiro continuam sem NFC-e.

A cobertura que falta é a assinatura e a gravação real da nota. Ela só deve ser exercida numa sprint própria, com certificado de homologação e sem transmissão de documento de cliente. Não faz parte desta auditoria.
