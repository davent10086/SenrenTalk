from elasticsearch import Elasticsearch
import os
import warnings
from urllib3.exceptions import InsecureRequestWarning

warnings.simplefilter('ignore', InsecureRequestWarning)

es = Elasticsearch(
    os.environ.get('ES_URL') or 'https://127.0.0.1:9200/',
    basic_auth=(os.environ.get('ES_USERNAME') or 'elastic', os.environ.get('ES_PASSWORD') or 'Lijunwei111'),
    verify_certs=False,
    ssl_show_warn=False,
    request_timeout=120,
)

print('=== ES 索引状态检查 ===')
print()

index_name = os.environ.get('ES_INDEX_NAME', 'senren_dialogues')
print(f'索引名称: {index_name}')

if es.indices.exists(index=index_name):
    print('索引状态: 存在')
    
    stats = es.indices.stats(index=index_name)
    doc_count = stats['_all']['total']['docs']['count']
    print(f'文档总数: {doc_count}')
    
    result = es.search(
        index=index_name,
        size=0,
        aggs={
            'record_types': {'terms': {'field': 'record_type', 'size': 10}},
            'characters': {'terms': {'field': 'character', 'size': 20}},
            'playable': {'terms': {'field': 'is_playable', 'size': 5}},
        }
    )
    
    print()
    print('=== 记录类型分布 ===')
    for bucket in result['aggregations']['record_types']['buckets']:
        key = bucket['key']
        count = bucket['doc_count']
        print(f'  {key}: {count} 条')
    
    print()
    print('=== 角色分布 (前20) ===')
    for bucket in result['aggregations']['characters']['buckets']:
        key = bucket['key']
        count = bucket['doc_count']
        print(f'  {key}: {count} 条')
    
    print()
    print('=== 是否可扮演 ===')
    for bucket in result['aggregations']['playable']['buckets']:
        key = bucket['key']
        count = bucket['doc_count']
        label = '可扮演' if key else '非可扮演'
        print(f'  {label}: {count} 条')
    
    print()
    print('=== 章节分布 (前10) ===')
    result2 = es.search(
        index=index_name,
        size=0,
        aggs={
            'chapters': {'terms': {'field': 'chapter', 'size': 10}},
        }
    )
    for bucket in result2['aggregations']['chapters']['buckets']:
        key = bucket['key']
        count = bucket['doc_count']
        print(f'  {key}: {count} 条')

else:
    print('索引状态: 不存在')
    print('请先运行索引构建脚本')
