# Canais dinâmicos e empresas responsáveis

**ID:** CDS-EMPRESA-CANAL-DINAMICO-02

A seção continua em **Central de Configurações → Empresas por Canal de Venda**. Não há menu novo.

## Modelo de dados

Tabela `canais_venda`:

| Campo | Uso |
|---|---|
| id | Identificador interno estável |
| nome | Nome informado pelo usuário |
| codigo | Código único, normalizado |
| descricao | Opcional |
| tipo_origem | Texto livre, sem lista fechada no código |
| empresa_id | Empresa responsável, apontando para `empresas` |
| ativo | 1 ou 0 |
| criado_em / atualizado_em | Datas da ficha |

O CNPJ não é gravado no canal. A consulta lê `empresas.cnpj`.

A tabela `canais_venda_auditoria` registra troca de empresa e de status. Ela não altera `vendas` nem `pedidos`.

As tabelas são criadas na primeira consulta da seção. A implementação não abriu o banco oficial.

## Cadastro

O usuário informa nome, código, tipo, descrição, empresa e se o canal fica ativo. Exemplos como iFood, 99Food ou WhatsApp são fichas, não códigos fixos do sistema.

Canal ativo sem empresa é recusado. Empresa inativa é recusada. Código repetido é recusado. O canal `PDV` não é editado por essa ficha.

## Vínculo

A lista mostra o canal, o código, a empresa, o CNPJ e o status. Dá para trocar a empresa de um canal personalizado, desativar o canal e abrir o cadastro de empresas já existente.

## Resolução

`resolverEmpresaDoCanal` recebe o id ou o código estável, o usuário e a configuração.

Para qualquer canal que não seja PDV:

1. O canal precisa existir e estar ativo.
2. Precisa ter empresa responsável ativa.
3. O usuário precisa estar autorizado para essa empresa.
4. A resposta traz `empresa_id` e o CNPJ lido do cadastro.
5. Canal desconhecido não cai na matriz.

## PDV

`pdv_modelo_empresa` e `pdv_empresa_id` continuam no arquivo de configuração e no bloco Canal PDV.

No modo `UNICA`, a resolução do PDV usa `pdv_empresa_id`, mesmo que a linha espelhada do canal tenha outro número. No modo `MULTIPLAS`, a resolução não aplica empresa fixa e devolve `PDV_MULTIPLAS`, preservando `pdv_empresa_id`.

Não há um segundo resolvedor do PDV.

## Segurança

| Situação | Resultado |
|---|---|
| Canal sem empresa | `CANAL_SEM_EMPRESA` |
| Empresa inativa | `EMPRESA_INATIVA` |
| Usuário fora da empresa | `CANAL_USUARIO_SEM_AUTORIZACAO` |
| Canal inexistente | `CANAL_INEXISTENTE` |
| Canal inativo | `CANAL_INATIVO` |

As rotas ficam em `/api/configuracoes-avancadas/canais-venda` e usam a mesma exigência de super administrador da Central. Venda já gravada não é reescrita quando o vínculo muda.

## Testes

`node --test --test-concurrency=1 tests/vendas/canais-dinamicos-empresas.test.js`

8 testes, 8 aprovações, banco em memória. Cobrem os 17 cenários: cadastro, empresas diferentes e iguais, troca de vínculo, canal sem empresa, empresa inativa, canal inativo, usuário sem autorização, canal inexistente, PDV em `UNICA` e `MULTIPLAS`, pedido e venda antigos intactos, e CNPJ só na empresa.

## Pendências

O fechamento de venda e o pedido ainda usam o contexto empresarial atual. O resolvedor novo está disponível e o PDV não passou a consultá-lo no lugar de `pdv_empresa_id`. Ligar o resolvedor ao pedido e à venda de canais personalizados fica para uma sprint própria, sem mexer em composição, dinheiro, pagamento, estoque, TEF, PIX ou NFC-e.
