<?php
/**
 * Plugin Name: 4Comic OGP Meta REST API
 * Description: SWELL/SEO Simple PackのOGPカスタムフィールドをREST API経由で更新できるようにします。漫画半自動制作ツールと連携して使用してください。
 * Version: 1.0.0
 * Author: UmbrellaParade
 */

add_action('init', function () {
    $meta_keys = [
        'swell_meta_show_thumb',
        'swell_meta_show_related',
        'swell_meta_show_author',
        'ssp_meta_image',
        'ssp_meta_ogp_img',
        'ssp_meta_og_image',
        '_yoast_wpseo_opengraph-image',
        'rank_math_facebook_image',
        'aioseo_og_image_custom_url',
        'og_image',
        'og_image_id',
    ];

    foreach ($meta_keys as $key) {
        register_post_meta('post', $key, [
            'show_in_rest'  => true,
            'single'        => true,
            'type'          => 'string',
            'auth_callback' => function () {
                return current_user_can('edit_posts');
            },
        ]);
    }
});
