# Sprint 21H — Homologação visual do histórico de vendas

Homologação no PDV autenticado, no navegador, com banco temporário e vendas preparadas. Nenhuma correção foi implementada.

Data: 31/10/2026.

Parecer: **REPROVADA**.

A lista, o modal e o isolamento por empresa foram conferidos na tela. A reimpressão do cupom não fiscal não abre: a consulta da reimpressão não envia a empresa e o servidor recusa o pedido.

## 1. Ambiente

| Item | Valor |
|---|---|
| Servidor | `http://127.0.0.1:3217`, processo encerrado ao fim da homologação |
| Banco | `C:\Users\cicer\AppData\Local\Temp\cds-sprint21h-qW5p65\mercadao.db` |
| Log de boot | `BANCO DE TESTE EM USO` nesse caminho |
| Operador | `op21h`, perfil CAIXA, senha só neste banco temporário |
| Empresas | Pastelaria A (id 1) e Pastelaria B (id 2), as duas vinculadas ao operador |
| Licença | registro local `HOMOLOG-21H-TEMP`, só para o PDV abrir neste banco |

O banco oficial não foi aberto. `CDS_ALLOW_OFFICIAL_DB` não foi definido. A configuração de produção não foi gravada: o servidor copiou a configuração para a pasta temporária do `DB_DIR`.

Vendas inseridas direto nas tabelas, com TEF simulado já gravado. Nenhuma venda foi fechada pelo PDV. Nenhuma autorização de adquirente, PIX, NFC-e, NF-e ou SEFAZ foi disparada. No log, a recuperação de XML ficou com `autorizaTransmissaoSefaz: false`. O ciclo de manifestação concluiu com `executado: false` e `candidatos: 0`.

## 2. Dados preparados

| Código | Empresa | Total | Conteúdo |
|---|---|---|---|
| H-CARTAO | A | 10,00 | Cartão crédito, NSU `NSU-CARTAO`, autorização `AUT-CARTAO` |
| H-DINHEIRO | A | 8,00 | Dinheiro, sem TEF, valor não fiscal 8,00 |
| H-MEIOS | A | 15,00 | Dinheiro 5,00 e cartão débito 10,00 |
| H-MISTA | A | 10,00 | Pagamento comercial 10,00; recebimentos fiscal 6,00 e não fiscal 4,00 |
| H-OUTRA | B | 22,00 | Cartão crédito, NSU `NSU-EMPRESA-B`, autorização `AUT-EMPRESA-B` |

## 3. Cenários na tela

O PDV abriu em `/pdv/` depois do login. O histórico foi aberto pelo menu **Reimpressão de Cupom**. A tela de histórico carregou sem erro de JavaScript.

Na Pastelaria A a lista mostrou 4 vendas e não mostrou `H-OUTRA` nem `NSU-EMPRESA-B`.

| Venda | Lista | Modal |
|---|---|---|
| H-CARTAO | Cartão crédito R$ 10,00; Concluída; Quitado | Total R$ 10,00. Pagamento R$ 10,00, transação 1, NSU `NSU-CARTAO`, autorização `AUT-CARTAO`. Recebimento fiscal R$ 10,00 com o mesmo NSU e a mesma autorização. |
| H-MEIOS | Dinheiro R$ 5,00 e cartão débito R$ 10,00; total R$ 15,00; Concluída; Quitado | Dois meios, 5,00 e 10,00, sem NSU. Dois recebimentos fiscais nos mesmos valores. Total R$ 15,00. |
| H-MISTA | Cartão crédito R$ 10,00; total R$ 10,00; Concluída; Quitado | Pagamento comercial R$ 10,00. Recebimentos fiscal R$ 6,00 e não fiscal R$ 4,00. Aviso de comprovante não fiscal R$ 4,00. Total comercial R$ 10,00. |
| H-DINHEIRO | Dinheiro R$ 8,00; Concluída; Quitado | Conferida na lista. O modal não foi aberto de novo; o cupom dessa venda usa a mesma função que falhou em H-MISTA. |

Status da venda e status do pagamento aparecem em colunas e rótulos separados. Os valores das tabelas de pagamento e de recebimento não foram somados ao total comercial. Em H-MISTA o total permaneceu R$ 10,00 com as fatias 6,00 e 4,00 ao lado.

Na Pastelaria B, depois de trocar o seletor e clicar em **Atualizar**, a lista ficou com 1 venda: `H-OUTRA`, R$ 22,00, Concluída, Quitado. O modal mostrou NSU `NSU-EMPRESA-B` e autorização `AUT-EMPRESA-B`. `H-CARTAO` e `NSU-CARTAO` não apareceram.

A troca de empresa no seletor não recarrega o histórico sozinha. A lista da empresa anterior permanece até **Atualizar**. Depois do clique, a consulta respeitou a empresa selecionada.

## 4. Reimpressão

Em H-MISTA o botão **Reimprimir cupom não fiscal** está no modal. O clique executou `reimprimirCupomNaoFiscalHistorico`. O cupom não abriu.

Console do navegador, duas vezes:

`Erro ao reimprimir cupom não fiscal: Error: Contexto empresarial obrigatório para operação de venda. Informe X-Empresa-Id.`

Causa: `frontend/shared/js/fiscalImpressao.js`, função `reimprimirCupomNaoFiscalHistorico`, faz `fetch` de `GET /api/vendas/:id` só com `Authorization`. A lista e o modal usam `$.ajax`, que recebe `X-Empresa-Id`. Com duas empresas no contexto, o backend exige o header e responde erro. O total do cupom não pôde ser visto porque o comprovante não foi montado.

Nenhuma correção foi feita.

## 5. Critérios

| Critério | Resultado |
|---|---|
| Tela abre sem erro de JavaScript | Atendido na abertura do histórico e dos modais |
| Lista carrega | Atendido |
| Modal com dados persistidos | Atendido |
| NSU e autorização iguais aos registros | Atendido em H-CARTAO e H-OUTRA |
| Status da venda e do pagamento separados | Atendido |
| Total comercial correto | Atendido |
| Sem duplicar valores | Atendido |
| Consulta respeita a empresa | Atendido depois de Atualizar |
| Cupom com o total correto | Não atendido. O cupom não abre |
| Sem regressão relevante | A reimpressão falha no PDV com mais de uma empresa |

## 6. Arquivos alterados

Nenhum arquivo de produção, teste ou banco foi alterado nesta sprint. O único arquivo novo é este relatório.

## 7. Operações reais

Autorizações financeiras reais: 0. Emissões de NFC-e ou NF-e: 0. Transmissões à SEFAZ: 0. O banco oficial não foi usado.

## 8. Encerramento

Parecer: **REPROVADA** pelo cupom não fiscal. O restante do histórico conferido na tela está de acordo com os registros preparados.

Nenhuma outra sprint foi iniciada. Aguardando avaliação do Tech Lead.
