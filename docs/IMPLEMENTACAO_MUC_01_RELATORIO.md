# SPRINT MUC-01

STATUS:  
CONCLUÍDA

TIPO:  
AUDITORIA

MUC EXISTENTE:  
PARCIAL

IMPLEMENTAÇÃO PRINCIPAL:  
`backend/motores/muc/` (`obterMuc` / `MotorUniversalConversao` RC2.1). Cálculo de estoque na compra delega a `backend/lib/motorConversaoUnidades.js`. SI (kg↔g, L↔ml) está em `backend/services/unidades/MotorUnidadesMedida.js`, usado pela ficha/consumo — **não** pelo pipeline MUC.

ARQUIVOS:  
~27 módulos em `motores/muc/` + legado + MotorUM + embalagens + ficha/consumo + `rotas/compras.js`

SERVICES:  
`obterMuc`, `MotorConversao`, `ProdutoEmbalagemService`, `MotorUnidadesMedida`, `FichaTecnicaService`, `FichaTecnicaConsumoService`, crédito de estoque de compra (pós-conversão)

APIS:  
POST `/api/compras`; POST `/api/compras/simular-conversao-muc`; GET/POST embalagens produto; POST/PUT produtos (UC); GET/PUT ficha-técnica; POST `/api/vendas` (consumo MotorUM)

TABELAS:  
`produto_embalagens`, `compras_itens` (fator/JSON MUC), `muc_auditoria_conversao`, `muc_aprendizado`, `produtos` (unidade/UC/fracionado), `ficha_tecnica_itens`, `venda_ficha_consumo_itens`

MÓDULOS CONSUMIDORES:  
Compras (MUC); cadastro produto/embalagem (MotorUM + apresentações); ficha consumo (MotorUM); estoque (quantidade já convertida); importação inicial (fator próprio)

CONVERSÕES ENCONTRADAS:  
5 famílias — MUC multiplicador; legado `obterQuantidadeConvertida`; MotorUM SI; MotorUM `calcularCompraEmbalagem`; fator de importação inicial

CONVERSÕES HARDCODED:  
`FATOR_UNIDADE_BASE` (SI legítimo); catálogo VOLUME/PESO sem efeito no cálculo; Toledo `/1000` (equipamento); round `*1000/1000` (3 casas)

EMBALAGENS:  
1 apresentação = 1 fator (ex. 1 CX = 12 UN). Sem encadeamento UN→ml no motor.

CONVERSÃO COMPRA → ESTOQUE:  
NÃO para o exemplo 12 CX Coca 2 L → 24.000 ml. Resultado atual típico: 12 × 12 = 144 na `unidade` do produto.

CONVERSÃO FICHA → ESTOQUE:  
SIM na família SI via MotorUM (ex. 300 ml → 0,3 L). NÃO via `obterMuc`.

CONVERSÃO ESTORNO:  
Snapshot `venda_ficha_consumo_itens` (03.07/03.08); mesma unidade do consumo; sem reconversão.

SNAPSHOT:  
`quantidade`+`unidade` (estoque) e `quantidade_ficha`+`unidade_ficha`. Sem fator. Suficiente para estorno.

PRECISÃO:  
MotorUM SI 6 casas; MUC/DTO 4; consumo `round3`; SQLite REAL.

MULTIEMPRESA:  
Definição no produto/ficha compartilhada. Estoque por `empresa_id` da movimentação. MUC não escolhe empresa.

COMERCIAL:  
Modelo atual permite venda direta + `unidade` de estoque SI **se** o fator único for cadastrado. Encadeamento 12 UN × 2.000 ml **não** existe no MUC.

INSUMO:  
`tipo_operacional` intacto. Ficha SI já opera. Compra do insumo em fardo = um hop MUC.

PASTEL ESPECIAL:  
Dependência futura. MUC não modela 6 escolhas de 42; só converteria cada linha g/ml/UN.

P0:  
Nenhum no caminho ficha SI + snapshot + estorno. P0 latente se estoque em ml e compra só CX→UN sem segundo fator.

P1:  
Dois motores; sem encadeamento; VOLUME/PESO só rótulo; importação paralela; Coca/água no modelo proposto não automático.

P2:  
Unificar API; precisão 6 vs 3; API SI para UI.

RISCOS:  
Dois caminhos divergirem; cadastro `unidade=ml` com fator 12; default `'un'` no MUC; dual-write estoque (já 03.09).

TESTES:  
auditoria-muc-01 13/13; muc-public-contract 20/20; muc-rc1 17/17; muc-rc2 18/18; rc431-build 29/29; rc842 13/13; 03.01 20/20; 03.02 28/28; 03.03 25/25; 03.04 35/35; 03.07 20/20; 03.08 25/25; 03.09 14/14.

REGRESSÕES:  
Produção não alterada. `tests/compras/rc840-unidades-isolamento.test.js` falhou 1 caso de UI (`unidade_comercial` no JS do cadastro) — pré-existente, não introduzido nem mascarado nesta auditoria.

ARQUITETURA RECOMENDADA:  
Um MUC: qtd+unidade origem → qtd+unidade destino (embalagem + SI encadeável). Compras, ficha e estoque só consomem. Empresa só na movimentação.

CONCLUSÃO:  
**MUC APTO PARA EVOLUÇÃO CONTROLADA.** Não reconstruir. Não é ainda o conversor único. Lacuna principal: encadeamento e SI dentro do pipeline usado pelas compras.

PRÓXIMA SPRINT:  
MUC-02 (sugerida, não iniciada): etapa SI + encadeamento no pipeline, testes Coca/água conceituais, **sem** mudar cadastro/compras/ficha até o contrato único existir. Não iniciar automaticamente.
