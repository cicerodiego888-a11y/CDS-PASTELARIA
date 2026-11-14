# CDS-CANAIS-VENDA-GESTAO-P11

## Auditoria do estado anterior

- Listagem e cadastro já existiam em `GET/POST /api/configuracoes-avancadas/canais-venda`.
- `PUT /api/configuracoes-avancadas/canais-venda/:id` já permitia alterar empresa e situação, e o serviço também aceitava parcialmente nome, descrição e tipo; essas três propriedades não eram auditadas.
- A reativação já era tecnicamente aceita pelo serviço, mas não estava disponível na interface nem validava o código persistido.
- `canais_venda_auditoria` já registrava empresa e situação. Não havia endpoint de consulta do histórico.
- Não havia endpoint nem ação de exclusão física. A inativação existente é exclusão lógica e permanece como mecanismo de desativação.
- A listagem existente não tinha busca ou filtros; a interface permitia apenas trocar a empresa e desativar canais ativos.
- As rotas administrativas existentes já usavam `exigirSuperAdmin`.

## Gestão implementada

O `PUT` agora edita nome, descrição, tipo/origem, empresa responsável e situação. O código é imutável; tentativas de alteração recebem conflito. A reativação valida empresa existente/ativa, código normalizado e unicidade. O resolver comercial continua rejeitando canais inativos.

Atualização e auditoria usam uma transação `BEGIN IMMEDIATE` na conexão exclusiva do banco, com fallback para conexão in-memory em testes. Falha de auditoria reverte a atualização. O cadastro inicial também é atômico e registra snapshots completos.

O schema de auditoria evolui de forma aditiva e idempotente com seis colunas: nome, descrição e tipo/origem anteriores e novos. Linhas antigas permanecem intactas, com os novos campos nulos quando não existiam. A migration não foi executada no banco oficial; como a evolução é aditiva, não há reversão automática que descarte esses dados históricos.

O histórico é consultável em `GET /api/configuracoes-avancadas/canais-venda/:id/historico`, protegido por `SUPER_ADMIN`. Não foi criada exclusão física: canais são preservados e inativados. Pedidos, vendas e seus vínculos históricos não são alterados.

A tela atual agora oferece busca por nome/código, filtros por empresa e situação, edição com código somente leitura, ativação/inativação com confirmação, indicação de vínculos inválidos e consulta inline do histórico. O canal PDV permanece gerenciado exclusivamente pela configuração existente.

## Segurança e verificação

Todas as rotas de gestão e histórico continuam protegidas por `exigirSuperAdmin`. Não foi adicionada uma permissão paralela nem uma rota de exclusão. Os testes usam SQLite em memória ou arquivo temporário; nenhum dado comercial real foi criado e o banco oficial não foi aberto.
