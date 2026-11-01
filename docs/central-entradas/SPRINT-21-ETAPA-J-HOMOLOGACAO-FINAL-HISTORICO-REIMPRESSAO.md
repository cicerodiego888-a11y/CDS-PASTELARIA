# Sprint 21J — Homologação visual final da consulta e da reimpressão

Homologação no PDV autenticado, no navegador, depois da correção da Sprint 21I. Banco temporário e vendas preparadas. Nenhum código de produção foi alterado nesta etapa.

Data: 31/10/2026.

Parecer: **APROVADA**.

A lista, o modal e a reimpressão da empresa A conferem. O cupom de H-MISTA imprime só o recebimento não fiscal de R$ 4,00, uma vez. A empresa B, depois de Atualizar, vê e reimprime só a própria venda. Sem empresa ativa, a reimpressão avisa e não consulta.

## 1. Ambiente

| Item | Valor |
|---|---|
| Servidor | `http://127.0.0.1:3218`, processo encerrado ao fim da homologação |
| Banco | `C:\Users\cicer\AppData\Local\Temp\cds-sprint21j-fEvkh1\mercadao.db` |
| Log de boot | `BANCO DE TESTE EM USO` nesse caminho |
| Operador | `op21j`, perfil CAIXA, senha só neste banco temporário |
| Empresas | Pastelaria A (id 1) e Pastelaria B (id 2), as duas vinculadas ao operador |
| Licença | registro local `HOMOLOG-21J-TEMP`, só para o PDV abrir neste banco |

O banco oficial não foi aberto. `CDS_ALLOW_OFFICIAL_DB` não foi definido. `CDS_BLOQUEAR_BANCO_OFICIAL=1`. A configuração de produção não foi gravada: o servidor copiou a configuração para a pasta temporária do `DB_DIR`. O `git status` ao fim da etapa não mostra arquivo de produção novo além dos que já estavam nas sprints anteriores.

Vendas inseridas direto nas tabelas, com TEF simulado já gravado. Nenhuma venda foi fechada pelo PDV. Nenhuma autorização de adquirente, PIX, NFC-e, NF-e ou SEFAZ foi disparada.

Contadores no log do servidor:

| Contador | Valor |
|---|---|
| Autorizações reais de TEF, PIX ou adquirente | 0 |
| Emissões fiscais e transmissões à SEFAZ | 0 |
| `autorizaTransmissaoSefaz` | false |
| Recuperação de XML | `SLEEP`, motor desativado |
| Manifestação | `executado: false`, `candidatos: 0`, `politica: MANUAL` |

O diálogo de impressão do sistema foi substituído só na página aberta, para ler o HTML que a função de produção já monta. `fiscalImpressao.js` não foi editado. A função chamou `print()` nesse substituto.

## 2. Dados preparados

| Código | Id | Empresa | Total comercial | Cupom não fiscal |
|---|---|---|---|---|
| H-CARTAO | 1 | A | R$ 10,00 | Não fiscal R$ 10,00, NSU `NSU-CARTAO`, autorização `AUT-CARTAO` |
| H-MISTA | 2 | A | R$ 10,00 | Recebimento fiscal R$ 6,00 e não fiscal R$ 4,00, NSU `NSU-MISTA`, autorização `AUT-MISTA` |
| H-OUTRA | 3 | B | R$ 22,00 | Não fiscal R$ 22,00, NSU `NSU-EMPRESA-B`, autorização `AUT-EMPRESA-B` |

H-CARTAO foi gravado como não fiscal para o botão de reimpressão aparecer. Venda só fiscal não oferece esse botão. O NSU e a autorização continuam os do pagamento persistido.

## 3. Cenários na tela

O PDV abriu em `/pdv/` depois do login de `op21j`. O histórico foi aberto pelo menu **Reimpressão de Cupom**, com Pastelaria A selecionada.

1. PDV autenticado. Abriu em `/pdv/`.
2. Reimpressão de Cupom. Título **Histórico de Vendas**.
3. Empresa A. Lista com 2 vendas: H-MISTA e H-CARTAO, ambas R$ 10,00, cartão crédito, Concluída, Quitado. H-OUTRA não apareceu. O modal de H-CARTAO mostrou NSU `NSU-CARTAO` e autorização `AUT-CARTAO`. O modal de H-MISTA mostrou total comercial R$ 10,00, aviso de comprovante não fiscal R$ 4,00, recebimento fiscal R$ 6,00 e recebimento não fiscal R$ 4,00 com `NSU-MISTA` / `AUT-MISTA`.
4. Reimpressão de H-CARTAO. Consulta `GET /api/vendas/1` com `Authorization` e `X-Empresa-Id: 1`. Cupom: `Total: R$ 10,00`, `NSU: NSU-CARTAO`, `Aut.: AUT-CARTAO`.
5. Reimpressão de H-MISTA. O cupom lista o recebimento não fiscal: `Cartão de Crédito R$ 4,00`, `NSU: NSU-MISTA`, `Aut.: AUT-MISTA`.
6. O mesmo cupom tem uma linha `Total: R$ 4,00`. Não contém R$ 10,00, R$ 6,00, R$ 14,00 nem R$ 20,00.
7. Troca para Pastelaria B e clique em **Atualizar**. A lista passou a 1 venda: H-OUTRA, R$ 22,00. A reimpressão consultou `GET /api/vendas/3` com `X-Empresa-Id: 2`. Cupom: `Total: R$ 22,00`, `NSU: NSU-EMPRESA-B`, `Aut.: AUT-EMPRESA-B`.
8. A lista da empresa B não mostrou H-CARTAO nem H-MISTA. A reimpressão da venda 1, com a empresa B ativa, recebeu `Venda não encontrada.` Nenhum cupom foi montado e nenhum NSU da empresa A apareceu.
9. `CdsEmpresaContexto.limpar()` esvaziou a empresa ativa (`temEmpresaSelecionada` falso, id nulo). O clique em **Reimprimir cupom não fiscal** mostrou `Selecione a empresa no seletor da barra lateral para continuar.` Consultas de venda depois da limpeza: 0. Cupons: 0.
10. Os caminhos de lista, modal e reimpressão concluída não geraram erro de console. O `console.error` de `Venda não encontrada.` ocorreu só na tentativa cruzada do item 8, no tratamento já existente da resposta recusada.

O seletor não tem opção de limpar. Depois de `limpar()`, o combobox ainda exibia Pastelaria B, e a reimpressão mesmo assim ficou bloqueada porque o contexto oficial estava vazio.

A data da lista ficou 31/10/2026 e a data impressa no cupom ficou 30/10/2026, 21:00:00. O total, o NSU e a autorização conferem. Isso não altera o parecer.

## 4. Erros encontrados

Nenhum defeito de reimpressão, de total ou de isolamento. A falha da Sprint 21H, consulta sem `X-Empresa-Id`, não se repetiu.

## 5. Parecer

**APROVADA.**

A correção da Sprint 21I vale no PDV autenticado: a reimpressão usa a empresa ativa, o cupom misto imprime R$ 4,00 uma vez, a outra empresa não recebe as vendas alheias, e a ausência de empresa bloqueia a consulta.

Nenhuma outra sprint foi iniciada.
