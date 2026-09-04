# SPRINT MUC-02

STATUS:  
CONCLUÍDA

MUC:  
RC2.1 evoluído (facade preservada). Núcleo MUC-02: `converterQuantidade` + SI + encadeamento.

SI:  
Implementado no MUC (MASSA, VOLUME, COMPRIMENTO, UN). MotorUM delega a conversão SI ao MUC.

ENCADEAMENTO:  
Implementado (grafo + BFS). Coca 12 CX → 288.000 ML. Água 10 FARDO → 42.000 ML.

COMPRAS:  
Já consumia `resultadoMuc.quantidadeEstoque`. Pipeline passa a calcular pelo MUC-02 (apresentações + `relacoes`). Sem workaround paralelo.

FICHA:  
Consumo usa `obterMuc(db).converterQuantidade`. Snapshot e estorno 03.07/03.08 intactos.

MOTORUM:  
DEPRECADO para conversão SI (wrapper). Ainda utilizado: `normalizarUnidadeComercial`, formação de preço, flags de embalagem no cadastro.

LEGADO:  
`motorConversaoUnidades.js` DEPRECADO como autoridade; permanece custo/F-NF. Importação inicial ainda tem `fator_conversao` próprio.

TESTES:  
muc-02 25/25; muc-01 auditoria 13/13; public 20/20; rc1 17/17; rc2 18/18; rc431 29/29; rc842 13/13; 03.01 20/20; 03.02 28/28; 03.03 25/25; 03.04 35/35; 03.07 20/20; 03.08 25/25; 03.09 14/14.

REGRESSÕES:  
03.03 T13 e 03.04 T14 atualizados só no *wiring* (MotorConversao → obterMuc / converterQuantidade), sem alterar resultados numéricos. rc840 UI `unidade_comercial` não reexecutado como bloqueio (pré-existente MUC-01).

P0:  
Nenhum.

P1:  
Sem tela MUC-03, Coca/água em produção dependem de apresentações/relações cadastradas; importação inicial ainda fora do MUC.

P2:  
Retirar MotorUM da formação de preço quando houver sprint de preço; unificar round3 da ficha com o contrato 1e9.

RISCOS:  
Produto com `unidade=ML` e só CX×12 sem UN→ML falha com `CONVERSAO_NAO_DISPONIVEL` (não adivinha 2000). Dual-write de estoque (já 03.09).

CONCLUSÃO:  
MUC é a autoridade de conversão da nova arquitetura. RC2.1 compatível. Pronto para MUC-03 (cadastro: utiliza conversão, UC, unidade de estoque, apresentação, fator). Pastel Especial permanece depois.

PRÓXIMA SPRINT:  
MUC-03 — interface/configuração de cadastro. Não iniciada automaticamente.
